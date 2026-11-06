"""Create our own Xvfb display; never attach automation to the human DISPLAY."""
import argparse
import json
import os
import select
import signal
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from bridge import X11, serve


def start_xvfb(executable='Xvfb', width=1280, height=800):
    read_fd, write_fd = os.pipe()
    try:
        process = subprocess.Popen([executable, '-displayfd', str(write_fd), '-screen', '0', f'{width}x{height}x24', '-nolisten', 'tcp'], pass_fds=(write_fd,), stderr=subprocess.DEVNULL)
        os.close(write_fd)
        write_fd = None
        if not select.select([read_fd], [], [], 15)[0]:
            process.terminate()
            raise RuntimeError('Xvfb did not become ready')
        number = os.read(read_fd, 32).decode().strip()
        if not number.isdigit(): raise RuntimeError('Xvfb failed to allocate a display')
        return process, f':{number}'
    finally:
        os.close(read_fd)
        if write_fd is not None: os.close(write_fd)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    parser = argparse.ArgumentParser()
    parser.add_argument('--xvfb', default='Xvfb')
    parser.add_argument('--token-file', required=True)
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--width', type=int, default=1280)
    parser.add_argument('--height', type=int, default=800)
    parser.add_argument('--apps-file', help='JSON array of argv arrays to launch inside the isolated display')
    args = parser.parse_args()
    if os.environ.get('IC_PRIVATE_BUS') != '1':
        dbus = shutil.which('dbus-run-session')
        if not dbus: raise RuntimeError('Install dbus-run-session for a private accessibility/app bus')
        env = {k:v for k,v in os.environ.items() if k not in ('WAYLAND_DISPLAY','DBUS_SESSION_BUS_ADDRESS','XAUTHORITY','SESSION_MANAGER','AT_SPI_BUS_ADDRESS')}
        session_dir = Path(args.token_file).resolve().parent / ('session-' + uuid.uuid4().hex)
        for variable,name in [('XDG_RUNTIME_DIR','runtime'),('XDG_CONFIG_HOME','config'),('XDG_CACHE_HOME','cache'),('XDG_DATA_HOME','data')]:
            directory=session_dir/name;directory.mkdir(mode=0o700,parents=True,exist_ok=True);env[variable]=str(directory)
        env.update({'IC_PRIVATE_BUS':'1','NO_AT_BRIDGE':'0','GTK_A11Y':'atspi'})
        private = subprocess.Popen([dbus,'--',sys.executable,__file__,*sys.argv[1:]],env=env,start_new_session=True)
        try: sys.exit(private.wait())
        finally:
            if private.poll() is None:
                os.killpg(private.pid,signal.SIGTERM)
                try: private.wait(timeout=10)
                except subprocess.TimeoutExpired: os.killpg(private.pid,signal.SIGKILL);private.wait()
    if not 320 <= args.width <= 4096 or not 240 <= args.height <= 2160: parser.error('Invalid display size')
    process, display = start_xvfb(args.xvfb, args.width, args.height)
    children = []
    try:
        session_dir = Path(args.token_file).resolve().parent / f'session-{display[1:]}'
        session_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        env = {k: v for k, v in os.environ.items() if k not in ('WAYLAND_DISPLAY', 'XAUTHORITY', 'SESSION_MANAGER')}
        env.update({'DISPLAY': display, 'GDK_BACKEND': 'x11', 'QT_QPA_PLATFORM': 'xcb', 'SDL_VIDEODRIVER': 'x11', 'XDG_SESSION_TYPE': 'x11'})
        os.environ['DISPLAY'] = display
        # D-Bus was created before Xvfb; activation must use this private display too.
        update = shutil.which('dbus-update-activation-environment')
        if update: subprocess.run([update, f'DISPLAY={display}', 'XAUTHORITY=', 'WAYLAND_DISPLAY='], env=env, check=True, stdout=sys.stderr, stderr=sys.stderr)
        if args.apps_file:
            dbus = shutil.which('dbus-run-session')
            if not dbus: raise RuntimeError('Install dbus-run-session to avoid reusing the human session bus')
            apps = json.loads(Path(args.apps_file).read_text())
            if not isinstance(apps, list): raise ValueError('Expected app argv arrays')
            for argv in apps:
                if not isinstance(argv, list) or not argv or any(not isinstance(a, str) for a in argv): raise ValueError('Invalid app argv')
                children.append(subprocess.Popen(argv, env=env, stdout=sys.stderr, stderr=sys.stderr, start_new_session=True))
        serve(X11(display), {'kind': 'xvfb', 'display': display, 'managed': True}, args.token_file, args.port, [child.pid for child in children])
    finally:
        for child in children:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try: child.wait(timeout=5)
                except subprocess.TimeoutExpired: os.killpg(child.pid, signal.SIGKILL); child.wait()
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
