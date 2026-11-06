"""Exclusive, expiring human input on the already verified isolated display."""
import math
import secrets
import threading
import time


class HumanInput:
    TTL = 5

    def __init__(self, controller):
        self.controller = controller
        self.adapter = controller.adapter
        self.lease = None
        self.deadline = 0
        self.sequence = 0
        self.keys, self.buttons = set(), set()
        self.stopped = threading.Event()
        self.worker = threading.Thread(target=self.watchdog, daemon=True)
        self.worker.start()

    def release_keys(self):
        failures = []
        for code in list(self.keys):
            try:
                self.adapter.key_event(code, False)
                self.keys.discard(code)
            except Exception as error: failures.append(str(error))
        for button in list(self.buttons):
            try:
                self.adapter.button(button, False)
                self.buttons.discard(button)
            except Exception as error: failures.append(str(error))
        if failures: raise RuntimeError('Could not release input: ' + '; '.join(failures))

    def expire(self):
        if self.lease and time.monotonic() >= self.deadline:
            self.controller.paused.set()
            self.release_keys()
            self.lease = None

    def watchdog(self):
        while not self.stopped.wait(.1):
            try:
                with self.controller.lock: self.expire()
            except Exception:
                # Retry releases on the next tick; never resume AI after failure.
                self.controller.paused.set()

    def close(self):
        self.stopped.set()
        self.controller.paused.set()
        with self.controller.lock:
            self.controller.paused.set()
            self.release_keys()
            self.lease = None

    def status(self):
        return {'humanOwned': bool(self.lease), 'paused': self.controller.paused.is_set(),
                'heldKeys': len(self.keys), 'heldButtons': len(self.buttons)}

    def validate_events(self, events, dimensions):
        if not isinstance(events, list) or not 1 <= len(events) <= 64: raise ValueError('Expected 1..64 input events')
        width, height = self.adapter.size()
        if dimensions != {'width': width, 'height': height}: raise ValueError('Display size changed; take over again')
        fields = {'pointer': {'type', 'phase', 'x', 'y', 'button'},
                  'wheel': {'type', 'x', 'y', 'deltaX', 'deltaY'},
                  'key': {'type', 'key', 'down'}, 'text': {'type', 'text'}}
        def number(n, lo, hi): return type(n) in (int, float) and math.isfinite(n) and lo <= n <= hi
        for event in events:
            if not isinstance(event, dict) or event.get('type') not in fields or set(event) - fields[event['type']]: raise ValueError('Unknown input event')
            kind = event['type']
            if kind in ('pointer', 'wheel'):
                if not number(event.get('x'), 0, width - 1) or not number(event.get('y'), 0, height - 1): raise ValueError('Coordinates outside display')
            if kind == 'pointer':
                if event.get('phase') not in ('move', 'down', 'up') or event.get('button', 'left') not in ('left', 'middle', 'right'): raise ValueError('Invalid pointer event')
            if kind == 'wheel' and (not number(event.get('deltaX', 0), -10000, 10000) or not number(event.get('deltaY'), -10000, 10000)): raise ValueError('Invalid wheel distance')
            if kind == 'key':
                if type(event.get('down')) is not bool or not isinstance(event.get('key'), str) or not 1 <= len(event['key']) <= 30: raise ValueError('Invalid key event')
                self.adapter.keycode(event['key'])  # Preflight before any event is dispatched.
            if kind == 'text' and (not isinstance(event.get('text'), str) or len(event['text']) > 20000): raise ValueError('Invalid input text')

    def handle(self, body):
        operation = body.get('op')
        if operation == 'acquire': self.controller.paused.set()
        with self.controller.lock:
            self.expire()
            if operation == 'acquire':
                if self.lease: raise ValueError('Another human already owns the desktop')
                self.controller.paused.set()
                self.release_keys()
                self.lease, self.sequence = secrets.token_hex(32), 0
                self.deadline = time.monotonic() + self.TTL
                width, height = self.adapter.size()
                return {'lease': self.lease, 'width': width, 'height': height, 'leaseSeconds': self.TTL}
            if not self.lease or not secrets.compare_digest(str(body.get('lease', '')), self.lease): raise ValueError('Human input lease expired or revoked')
            if operation == 'heartbeat':
                self.deadline = time.monotonic() + self.TTL
                return self.status()
            if operation == 'releaseKeys':
                self.release_keys()
                return self.status()
            if operation == 'release':
                if type(body.get('resume')) is not bool: raise ValueError('Expected resume boolean')
                self.release_keys()
                self.lease = None
                (self.controller.paused.clear if body['resume'] else self.controller.paused.set)()
                return self.status()
            if operation != 'input': raise ValueError('Unknown human input operation')
            if type(body.get('sequence')) is not int or body['sequence'] != self.sequence + 1: raise ValueError('Out-of-order input sequence')
            try:
                self.validate_events(body.get('events'), body.get('dimensions'))
                self.sequence = body['sequence']
                self.deadline = time.monotonic() + self.TTL
                for event in body['events']:
                    kind = event['type']
                    if kind in ('pointer', 'wheel'): self.adapter.move(event['x'], event['y'])
                    if kind == 'pointer' and event['phase'] != 'move':
                        button, down = event.get('button', 'left'), event['phase'] == 'down'
                        if down: self.buttons.add(button)
                        self.adapter.button(button, down)
                        if not down: self.buttons.discard(button)
                    elif kind == 'wheel': self.adapter.scroll(event.get('deltaX', 0), event['deltaY'])
                    elif kind == 'key':
                        code, down = self.adapter.keycode(event['key']), event['down']
                        if down: self.keys.add(code)
                        self.adapter.key_event(code, down)
                        if not down: self.keys.discard(code)
                    elif kind == 'text':
                        # Clipboard-based Unicode input must not inherit held Shift/Alt/Ctrl.
                        held = list(self.keys)
                        for code in held: self.adapter.key_event(code, False)
                        try: self.adapter.text(event['text'])
                        finally:
                            for code in held: self.adapter.key_event(code, True)
                return {'sequence': self.sequence, **self.status()}
            except Exception:
                self.controller.paused.set()
                self.release_keys()
                self.lease = None
                raise
