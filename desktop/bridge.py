"""Run only in a managed Xvfb display or a dedicated guest/secondary computer."""
import argparse
import base64
import ctypes as C
import hashlib
import hmac
import io
import json
import math
import os
import platform
import re
import secrets
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from PIL import ImageGrab


def machine_id():
    system = platform.system()
    if system == 'Linux':
        raw = Path('/etc/machine-id').read_text().strip()
    elif system == 'Darwin':
        out = subprocess.check_output(['/usr/sbin/ioreg', '-rd1', '-c', 'IOPlatformExpertDevice'], text=True)
        raw = re.search(r'"IOPlatformUUID"\s*=\s*"([^"]+)"', out).group(1)
    elif system == 'Windows':
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Microsoft\Cryptography', 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as key:
            raw = winreg.QueryValueEx(key, 'MachineGuid')[0]
    else:
        raise RuntimeError('Unsupported operating system')
    return hashlib.sha256(raw.lower().encode()).hexdigest()


class X11:
    """Send input to this display only. Never access a second display implicitly."""
    def __init__(self, display):
        self.x = C.CDLL('libX11.so.6')
        self.xt = C.CDLL('libXtst.so.6')
        self.x.XInitThreads()
        self.x.XOpenDisplay.argtypes = [C.c_char_p]
        self.x.XOpenDisplay.restype = C.c_void_p
        self.d = self.x.XOpenDisplay(display.encode())
        if not self.d:
            raise RuntimeError('Cannot connect to isolated X11 display')
        signatures = {
            'XDefaultScreen': ([C.c_void_p], C.c_int),
            'XDisplayWidth': ([C.c_void_p, C.c_int], C.c_int),
            'XDisplayHeight': ([C.c_void_p, C.c_int], C.c_int),
            'XSync': ([C.c_void_p, C.c_int], C.c_int),
            'XFlush': ([C.c_void_p], C.c_int),
            'XStringToKeysym': ([C.c_char_p], C.c_ulong),
            'XKeysymToKeycode': ([C.c_void_p, C.c_ulong], C.c_ubyte),
        }
        for name, (args, result) in signatures.items():
            fn = getattr(self.x, name)
            fn.argtypes, fn.restype = args, result
        self.xt.XTestFakeMotionEvent.argtypes = [C.c_void_p, C.c_int, C.c_int, C.c_int, C.c_ulong]
        self.xt.XTestFakeButtonEvent.argtypes = [C.c_void_p, C.c_uint, C.c_int, C.c_ulong]
        self.xt.XTestFakeKeyEvent.argtypes = [C.c_void_p, C.c_uint, C.c_int, C.c_ulong]
        self.display = display
        self.screen = self.x.XDefaultScreen(self.d)

    def size(self):
        return self.x.XDisplayWidth(self.d, self.screen), self.x.XDisplayHeight(self.d, self.screen)

    def move(self, x, y):
        self.xt.XTestFakeMotionEvent(self.d, self.screen, round(x), round(y), 0)
        self.x.XSync(self.d, 0)

    def button(self, button, down):
        self.xt.XTestFakeButtonEvent(self.d, {'left': 1, 'middle': 2, 'right': 3}[button], down, 0)
        self.x.XSync(self.d, 0)

    def scroll(self, dx, dy):
        # X11 wheel events use discrete notches; convert requested pixels to ~100px notches.
        for delta, positive, negative in [(dy, 5, 4), (dx, 7, 6)]:
            for _ in range(math.ceil(abs(delta) / 100)):
                b = positive if delta > 0 else negative
                self.xt.XTestFakeButtonEvent(self.d, b, 1, 0)
                self.xt.XTestFakeButtonEvent(self.d, b, 0, 0)
        self.x.XSync(self.d, 0)

    def keycode(self, key):
        aliases = {'Control': 'Control_L', 'Ctrl': 'Control_L', 'Alt': 'Alt_L', 'Shift': 'Shift_L',
                   'Meta': 'Super_L', 'Super': 'Super_L', 'Command': 'Super_L', 'Enter': 'Return',
                   'Backspace': 'BackSpace', 'Escape': 'Escape', 'Space': 'space', 'ArrowLeft': 'Left',
                   'ArrowRight': 'Right', 'ArrowUp': 'Up', 'ArrowDown': 'Down'}
        key = aliases.get(key, key)
        sym = self.x.XStringToKeysym(key.encode())
        code = self.x.XKeysymToKeycode(self.d, sym)
        if not code:
            raise ValueError(f'Unsupported key: {key}')
        return code

    def key(self, keys):
        codes = [self.keycode(k) for k in keys]
        try:
            for code in codes:
                self.xt.XTestFakeKeyEvent(self.d, code, 1, 0)
        finally:
            for code in reversed(codes):
                self.xt.XTestFakeKeyEvent(self.d, code, 0, 0)
            self.x.XSync(self.d, 0)

    def key_event(self, code, down):
        self.xt.XTestFakeKeyEvent(self.d, code, down, 0)
        self.x.XSync(self.d, 0)

    def text(self, text):
        if not text: return
        executable = os.environ.get('IC_XCLIP') or shutil.which('xclip')
        if not executable: raise RuntimeError('Install xclip for isolated Linux Unicode input')
        env = {**os.environ, 'DISPLAY': self.display}
        command = [executable, '-selection', 'clipboard']
        def read_clipboard():
            result = subprocess.run(command + ['-out'], env=env, capture_output=True, timeout=2)
            return result.stdout if result.returncode == 0 else None
        def own_clipboard(data):
            owner = subprocess.Popen(command + ['-in', '-quiet'], env=env, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            owner.stdin.write(data)
            owner.stdin.close()
            for _ in range(50):
                if read_clipboard() == data: return owner
                time.sleep(0.01)
            owner.terminate()
            raise RuntimeError('Isolated clipboard did not become ready')
        previous = read_clipboard()
        owner = own_clipboard(text.encode('utf-8'))
        try:
            self.key(['Control', 'v'])
            time.sleep(0.1)  # Clipboard selection transfer is asynchronous in X11 clients.
        finally:
            if previous is not None: self.clipboard_owner = own_clipboard(previous)
            if owner.poll() is None: owner.terminate()
            owner.wait(timeout=2)

    def screenshot(self):
        return ImageGrab.grab(xdisplay=self.display)


class Native:
    """Windows/macOS guest adapter; its desktop must be separate from the host."""
    def __init__(self):
        import pyautogui
        import pyperclip
        self.p, self.clip = pyautogui, pyperclip
        self.p.PAUSE = 0
        self.p.FAILSAFE = True
    def size(self): return tuple(self.p.size())
    def move(self, x, y): self.p.moveTo(x, y)
    def button(self, button, down):
        if down: self.p.mouseDown(button=button)
        else:
            previous = self.p.FAILSAFE
            try: self.p.FAILSAFE = False; self.p.mouseUp(button=button)
            finally: self.p.FAILSAFE = previous
    def scroll(self, dx, dy):
        if dy: self.p.scroll(-round(dy / 100))
        if dx: self.p.hscroll(round(dx / 100))
    def keycode(self, key):
        aliases = {'Control': 'ctrl', 'Ctrl': 'ctrl', 'Alt': 'alt', 'Shift': 'shift', 'Meta': 'command' if platform.system() == 'Darwin' else 'win',
                   'Command': 'command', 'Enter': 'enter', 'Escape': 'esc', 'Backspace': 'backspace',
                   'ArrowLeft': 'left', 'ArrowRight': 'right', 'ArrowUp': 'up', 'ArrowDown': 'down', 'Space': 'space'}
        translated = aliases.get(key, key.lower())
        if translated not in self.p.KEYBOARD_KEYS: raise ValueError('Unsupported key')
        return translated
    def key(self, keys): self.p.hotkey(*[self.keycode(k) for k in keys])
    def key_event(self, code, down):
        # Release must still work if the pointer hits PyAutoGUI's fail-safe corner.
        if down: self.p.keyDown(code)
        else:
            previous = self.p.FAILSAFE
            try: self.p.FAILSAFE = False; self.p.keyUp(code)
            finally: self.p.FAILSAFE = previous
    def text(self, text):
        previous = self.clip.paste()
        try:
            self.clip.copy(text)
            self.p.hotkey('command' if platform.system() == 'Darwin' else 'ctrl', 'v')
            time.sleep(0.08)
        finally: self.clip.copy(previous)
    def screenshot(self): return self.p.screenshot()


def validate_actions(actions, size):
    if not isinstance(actions, list) or not 1 <= len(actions) <= 32: raise ValueError('Expected 1..32 actions')
    fields = {'click': {'type', 'x', 'y', 'button', 'clicks'}, 'move': {'type', 'x', 'y'},
              'drag': {'type', 'path', 'button'}, 'scroll': {'type', 'x', 'y', 'deltaX', 'deltaY'},
              'type': {'type', 'text'}, 'key': {'type', 'keys'}, 'wait': {'type', 'ms'}}
    def number(value, minimum, maximum):
        return type(value) in (int, float) and math.isfinite(value) and minimum <= value <= maximum
    for action in actions:
        if not isinstance(action, dict) or action.get('type') not in fields: raise ValueError('Unknown action')
        kind = action['type']
        if set(action) - fields[kind]: raise ValueError('Unexpected action fields')
        if action.get('button', 'left') not in ('left', 'right', 'middle'): raise ValueError('Invalid mouse button')
        points = action.get('path', []) if kind == 'drag' else ([action] if kind in ('click', 'move', 'scroll') else [])
        if kind == 'drag' and (not isinstance(points, list) or not 2 <= len(points) <= 100): raise ValueError('Invalid drag path')
        for point in points:
            if not isinstance(point, dict) or not number(point.get('x'), 0, size[0] - 1) or not number(point.get('y'), 0, size[1] - 1): raise ValueError('Coordinates outside display')
        if kind == 'click' and (type(action.get('clicks', 1)) is not int or not 1 <= action.get('clicks', 1) <= 3): raise ValueError('Invalid click count')
        if kind == 'scroll' and (not number(action.get('deltaX', 0), -10000, 10000) or not number(action.get('deltaY'), -10000, 10000)): raise ValueError('Invalid scroll distance')
        if kind == 'type' and (not isinstance(action.get('text'), str) or len(action['text']) > 20000): raise ValueError('Invalid text')
        if kind == 'key' and (not isinstance(action.get('keys'), list) or not 1 <= len(action['keys']) <= 8 or any(not isinstance(k, str) or not 1 <= len(k) <= 30 for k in action['keys'])): raise ValueError('Invalid keys')
        if kind == 'wait' and (type(action.get('ms')) is not int or not 0 <= action['ms'] <= 3000): raise ValueError('Invalid wait')


class Controller:
    def __init__(self, adapter, isolation, owned_pids=()):
        self.adapter, self.isolation = adapter, isolation
        self.lock = threading.Lock()
        self.paused = threading.Event()
        self.ax_worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix='native-accessibility')
        self.ax, self.ax_error = None, None
        self.native_click_unavailable = ()
        try:
            from accessibility import create, NativeClickUnavailable
            self.native_click_unavailable = NativeClickUnavailable
            self.ax = self.ax_worker.submit(create, set(owned_pids)).result(timeout=10)
        except Exception as error: self.ax_error = str(error)
        from human_input import HumanInput
        self.human = HumanInput(self)
    def ax_call(self, method, *args):
        if not self.ax: raise ValueError('Native accessibility unavailable: ' + self.ax_error)
        return self.ax_worker.submit(getattr(self.ax, method), *args).result(timeout=30)
    def health(self):
        width, height = self.adapter.size()
        return {'machineID': machine_id(), 'platform': platform.system(), 'isolation': self.isolation, 'width': width, 'height': height, 'accessibilityAvailable': bool(self.ax), 'accessibilityError':self.ax_error, 'humanInput':self.human.status()}
    def capture(self, format):
        width, height = self.adapter.size()
        result = {'target': 'desktop', 'width': width, 'height': height, 'isolation': self.isolation}
        if self.ax: result['accessibility'] = self.ax_call('snapshot')
        else: result['accessibility'] = {'source':None, 'unavailable':self.ax_error}
        if format != 'none':
            image = self.adapter.screenshot()
            stream = io.BytesIO()
            image.convert('RGB').save(stream, format=format.upper(), **({'quality': 85} if format == 'jpeg' else {}))
            result['image'] = {'data': base64.b64encode(stream.getvalue()).decode(), 'mimeType': f'image/{format}'}
        return result
    def handle(self, path, body):
        format = body.get('capture', 'none')
        if format not in ('png', 'jpeg', 'none'): raise ValueError('Invalid capture format')
        fallback = None
        with self.lock:
            started = time.perf_counter()
            if path == '/controls':
                if self.human.lease: raise ValueError('Desktop is owned by human')
                actions = body.get('actions')
                if not isinstance(actions,list) or not 1 <= len(actions) <= 32: raise ValueError('Expected 1..32 actions')
                for action in actions:
                    if not isinstance(action,dict) or action.get('type') not in ('fill','click','select','check') or not isinstance(action.get('ref'),str): raise ValueError('Invalid semantic action')
                    if action['type']=='fill' and (not isinstance(action.get('text'),str) or len(action['text'])>20000): raise ValueError('Invalid text')
                for index, action in enumerate(actions):
                    if self.paused.is_set(): raise ValueError('Paused by user')
                    try:
                        self.ax_call('act',action)
                    except self.native_click_unavailable as error:
                        fallback = {
                            'kind': 'screenshot', 'reason': 'missing_native_click_action',
                            'status': 'needs_pixel_action', 'target': error.target,
                            'completedActions': index,
                            'pendingActions': [{'type': pending['type'], 'ref': pending['ref']} for pending in actions[index:]],
                            'nextStep': 'Inspect this screenshot, then use desktop_act to click the visible target; verify effects before continuing pending actions.'
                        }
                        if format == 'none': format = 'png'
                        break
            if path == '/act':
                if self.human.lease: raise ValueError('Desktop is owned by human')
                actions = body.get('actions')
                validate_actions(actions, self.adapter.size())
                # Preflight keys before any input in the batch.
                if isinstance(self.adapter, X11):
                    for action in actions:
                        if action['type'] == 'key':
                            for key in action['keys']: self.adapter.keycode(key)
                for action in actions:
                    if self.paused.is_set(): raise ValueError('Paused by user; earlier actions may have completed')
                    kind = action['type']
                    if kind in ('click', 'move', 'scroll'): self.adapter.move(action['x'], action['y'])
                    if kind == 'click':
                        for _ in range(action.get('clicks', 1)):
                            self.adapter.button(action.get('button', 'left'), True)
                            self.adapter.button(action.get('button', 'left'), False)
                    elif kind == 'scroll': self.adapter.scroll(action.get('deltaX', 0), action['deltaY'])
                    elif kind == 'type': self.adapter.text(action['text'])
                    elif kind == 'key': self.adapter.key(action['keys'])
                    elif kind == 'wait': time.sleep(action['ms'] / 1000)
                    elif kind == 'drag':
                        points = action['path']
                        self.adapter.move(points[0]['x'], points[0]['y'])
                        self.adapter.button(action.get('button', 'left'), True)
                        try:
                            for point in points[1:]: self.adapter.move(point['x'], point['y'])
                        finally: self.adapter.button(action.get('button', 'left'), False)
            action_ms = (time.perf_counter() - started) * 1000
        # AX providers can stall. Do not hold the input lock while observing:
        # watchdog/disconnect must remain able to release held input.
        result = self.capture(format)
        if fallback is not None:
            result['status'] = 'needs_pixel_action'
            result['fallback'] = fallback
        return {**result, 'actionMs': action_ms, 'totalMs': (time.perf_counter() - started) * 1000}


def serve(adapter, isolation, token_file, port=0, owned_pids=()):
    token_path = Path(token_file)
    if not token_path.exists():
        token_path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(token_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as file: file.write(secrets.token_urlsafe(32))
    token = token_path.read_text().strip()
    if len(token) < 32: raise ValueError('Token too short')
    controller = Controller(adapter, isolation, owned_pids)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def reply(self, status, value):
            data = json.dumps(value).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)
        def authorized(self):
            if not hmac.compare_digest(self.headers.get('Authorization', ''), f'Bearer {token}'):
                self.reply(401, {'error': 'Unauthorized'})
                return False
            return True
        def do_GET(self):
            if not self.authorized(): return
            if self.path != '/health': self.reply(404, {}); return
            self.reply(200, controller.health())
        def do_POST(self):
            if not self.authorized(): return
            if self.path not in ('/act', '/observe', '/control', '/controls', '/human', '/preview'): self.reply(404, {}); return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 1000000: raise ValueError('Invalid body size')
                body = json.loads(self.rfile.read(size))
                if not isinstance(body, dict): raise ValueError('Expected object')
                if self.path == '/control':
                    if type(body.get('paused')) is not bool: raise ValueError('Expected paused boolean')
                    if not body['paused'] and controller.human.lease: raise ValueError('Release human ownership before resuming AI')
                    (controller.paused.set if body['paused'] else controller.paused.clear)()
                    self.reply(200, {'paused': body['paused']})
                    return
                if self.path == '/human':
                    self.reply(200, controller.human.handle(body)); return
                if self.path == '/preview':
                    image = adapter.screenshot().convert('RGB')
                    stream = io.BytesIO(); image.save(stream, format='JPEG', quality=75)
                    self.reply(200, {'width':image.width,'height':image.height,'image':{'data':base64.b64encode(stream.getvalue()).decode(),'mimeType':'image/jpeg'}}); return
                self.reply(200, controller.handle(self.path, body))
            except (ValueError, KeyError, TypeError) as error: self.reply(400, {'error': str(error)})
            except Exception as error: self.reply(500, {'error': str(error)})
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(json.dumps({'url': f'http://127.0.0.1:{server.server_port}', 'tokenFile': str(token_path.resolve()), 'isolation': isolation}), flush=True)
    try: server.serve_forever()
    finally: controller.human.close(); server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--token-file', required=True)
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--dedicated-machine', action='store_true', help='Only use inside a VM or on a separate computer')
    args = parser.parse_args()
    if not args.dedicated_machine:
        parser.error('For Linux local isolation use linux_session.py; for a guest use --dedicated-machine')
    adapter = X11(os.environ['DISPLAY']) if platform.system() == 'Linux' else Native()
    serve(adapter, {'kind': 'dedicated'}, args.token_file, args.port)
