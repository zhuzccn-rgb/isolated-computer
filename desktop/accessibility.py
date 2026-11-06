"""Linux native AT-SPI. Only instantiated after the isolated session is created.

Calls run on one dedicated worker thread; no OS input or screenshot APIs are used.
The caller passes the PIDs of apps explicitly launched in this session.
"""
import secrets
import os
from pathlib import Path


class NativeClickUnavailable(ValueError):
    """A verified control needs screenshot-based input, not a native retry."""
    def __init__(self, target):
        super().__init__('Control has no supported native click action')
        self.target = target


class LinuxAccessibility:
    def __init__(self, owned_pids):
        import gi
        gi.require_version('Atspi', '2.0')
        from gi.repository import Atspi
        self.a = Atspi
        self.owned_pids = owned_pids
        self.refs = {}
        self.node_refs = {}
        self.generation = secrets.token_hex(8)
        self.next_ref = 0
        Atspi.set_timeout(1500, 3000)

    def fresh_state(self, node, cache=None):
        if cache is not None and node in cache:
            return cache[node]
        try:
            # Refresh only this object. Recursive clear_cache would repeatedly clear
            # whole subtrees during observation and does not replace an event loop.
            node.clear_cache_single()
            state = node.get_state_set()
        except Exception as error:
            raise ValueError('Control is unavailable; observe again') from error
        if cache is not None:
            cache[node] = state
        return state

    def availability(self, node, cache=None):
        state = self.fresh_state(node, cache)
        enabled = state.contains(self.a.StateType.ENABLED) or state.contains(self.a.StateType.SENSITIVE)
        visible = state.contains(self.a.StateType.VISIBLE) and state.contains(self.a.StateType.SHOWING)
        reason = None
        current, seen, attached_window = node, set(), False
        while current:
            if current in seen or len(seen) >= 32:
                reason = 'Cannot verify control ancestry; observe again'
                break
            seen.add(current)
            current_state = self.fresh_state(current, cache)
            if current_state.contains(self.a.StateType.DEFUNCT) or current_state.contains(self.a.StateType.STALE):
                reason = 'Control is unavailable or stale; observe again'
                break
            # Application/desktop roots do not have widget sensitivity semantics.
            if current.get_role() in (self.a.Role.APPLICATION, self.a.Role.DESKTOP_FRAME):
                break
            if current.get_role() in (self.a.Role.FRAME, self.a.Role.DIALOG, self.a.Role.WINDOW, self.a.Role.ALERT):
                attached_window = True
            if not (current_state.contains(self.a.StateType.ENABLED) or current_state.contains(self.a.StateType.SENSITIVE)):
                enabled = False
                reason = 'Control or ancestor is disabled'
                break
            if not (current_state.contains(self.a.StateType.VISIBLE) and current_state.contains(self.a.StateType.SHOWING)):
                visible = False
                reason = 'Control or ancestor is not showing'
                break
            current = current.get_parent()
        if reason is None and not attached_window and node.get_role() not in (self.a.Role.APPLICATION, self.a.Role.DESKTOP_FRAME):
            reason = 'Control is unavailable: no attached application window; observe again'
        return state, enabled, visible, reason

    def native_click_index(self, names):
        # Do not invoke arbitrary widget actions, or implicitly use mouse input.
        return next((i for i, name in enumerate(names) if name.lower() in ('click', 'press', 'activate')), None)

    def screenshot_target(self, node, ref):
        target = {'ref': ref, 'name': node.get_name(), 'role': node.get_role_name()}
        # Bounds are a hint for inspecting the screenshot, never an automatic
        # click point: controls can be clipped, occluded or move before input.
        if 'Component' in node.get_interfaces():
            try:
                rect = node.get_component_iface().get_extents(self.a.CoordType.SCREEN)
                if rect.width > 0 and rect.height > 0:
                    target['bounds'] = {'x': rect.x, 'y': rect.y, 'width': rect.width, 'height': rect.height}
            except Exception:
                pass
        return target

    def owned(self, pid):
        # Also allow children of explicitly launched apps, never arbitrary session applications.
        seen = set()
        while pid > 1 and pid not in seen:
            if pid in self.owned_pids: return True
            seen.add(pid)
            try:
                stat = Path(f'/proc/{pid}/stat').read_text()
                pid = int(stat[stat.rfind(')') + 2:].split()[1])
            except (OSError, ValueError): return False
        return False

    def snapshot(self):
        desktop = self.a.get_desktop(0)
        self.refs = {}
        controls, warnings, state_cache = [], [], {}
        visits = 0
        def visit(node, depth):
            nonlocal visits
            visits += 1
            if visits > 600 or depth > 20: return
            try:
                state, enabled, visible, reason = self.availability(node, state_cache)
                if state.contains(self.a.StateType.DEFUNCT): return
                role = node.get_role_name()
                protected = node.get_role() == self.a.Role.PASSWORD_TEXT
                if node not in self.node_refs:
                    self.node_refs[node] = f'atspi-{self.generation}-{self.next_ref}'
                    self.next_ref += 1
                ref = self.node_refs[node]
                self.refs[ref] = node
                interfaces = list(node.get_interfaces())
                item = {'ref': ref, 'role': role, 'name': node.get_name(), 'interfaces': interfaces,
                        'states': [s.value_nick for s in state.get_states()],
                        'sensitive': state.contains(self.a.StateType.SENSITIVE),
                        'enabled': bool(enabled), 'available': reason is None and bool(enabled) and bool(visible)}
                if reason: item['unavailableReason'] = reason
                if 'Text' in interfaces and not protected:
                    text = node.get_text_iface()
                    # GI exposes Accessible.get_text() (interface getter) under the same
                    # method name as Text.get_text(start,end); call the interface explicitly.
                    item['value'] = self.a.Text.get_text(text, 0, min(2000, text.get_character_count()))
                if 'Action' in interfaces:
                    action = node.get_action_iface()
                    item['actions'] = [action.get_action_name(i) for i in range(action.get_n_actions())]
                item['supportedActions'] = []
                if self.native_click_index(item.get('actions', [])) is not None:
                    item['supportedActions'].append('click')
                if ('EditableText' in interfaces and not protected and
                        state.contains(self.a.StateType.EDITABLE) and not state.contains(self.a.StateType.READ_ONLY)):
                    item['supportedActions'].append('fill')
                controls.append(item)
                for i in range(min(node.get_child_count(), 200)):
                    child = node.get_child_at_index(i)
                    if child: visit(child, depth + 1)
            except Exception as error: warnings.append(str(error)[:200])
        for i in range(desktop.get_child_count()):
            app = desktop.get_child_at_index(i)
            if app and self.owned(app.get_process_id()): visit(app, 0)
        self.node_refs = {node:ref for node,ref in self.node_refs.items() if ref in self.refs}
        return {'source': 'Linux native AT-SPI', 'controls': controls, 'truncated': visits > 600,
                'warnings': warnings[:10], 'scope': 'Only applications launched by this isolated session'}

    def act(self, action):
        node = self.refs.get(action.get('ref'))
        if not node: raise ValueError('Unknown or stale AT-SPI ref; observe again')
        if not self.owned(node.get_process_id()): raise ValueError('Application ownership revoked')
        state, enabled, visible, reason = self.availability(node)
        if reason: raise ValueError(reason)
        if not enabled or not visible: raise ValueError('Control is unavailable or disabled')
        interfaces = node.get_interfaces()
        if action['type'] == 'fill':
            if 'EditableText' not in interfaces or node.get_role() == self.a.Role.PASSWORD_TEXT:
                raise ValueError('No supported EditableText interface')
            if state.contains(self.a.StateType.READ_ONLY) or not state.contains(self.a.StateType.EDITABLE):
                raise ValueError('Control is read-only or not editable')
            if not node.get_editable_text_iface().set_text_contents(action['text']):
                raise ValueError('AT-SPI text action was rejected')
        elif action['type'] == 'click':
            if 'Action' not in interfaces: raise NativeClickUnavailable(self.screenshot_target(node, action['ref']))
            native = node.get_action_iface()
            names = [native.get_action_name(i).lower() for i in range(native.get_n_actions())]
            index = self.native_click_index(names)
            if index is None: raise NativeClickUnavailable(self.screenshot_target(node, action['ref']))
            if not native.do_action(index): raise ValueError('AT-SPI action was rejected')
        else: raise ValueError('Linux native adapter currently supports fill and click; select/check require a dedicated adapter')


def create(owned_pids):
    # Never discover the human session bus through inherited environment variables.
    if os.environ.get('IC_PRIVATE_BUS') != '1': raise RuntimeError('Accessibility requires a managed private D-Bus session')
    return LinuxAccessibility(owned_pids)
