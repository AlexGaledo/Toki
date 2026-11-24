"""Item 3: the real tray icon's menu through the native IUIAutomation (COM), which crosses the Windows 11 taskbar's
XAML island that System.Windows.Automation does not (see tray_uia.ps1's output in tray-click.txt).
  python tray_uia.py find                    read-only: list the notification area's buttons, find "Toki"
  python tray_uia.py click "Open your server" right-click the icon once, then Invoke that menu item through UIA
Needs comtypes (installed with pip --target into a temp folder, on PYTHONPATH)."""
import ctypes, sys, time
# This process stays DPI-unaware: UIA then gives the tray icon a consistent logical box (40x40 here), while a
# per-monitor-aware process got a 172 px box with its clickable point at the corner. The click goes through
# SetPhysicalCursorPos at that box's centre times the real scale (physical / logical screen width; 1920/1536 here).
def physical_scale():
    gdi, u = ctypes.windll.gdi32, ctypes.windll.user32
    dc = u.GetDC(0)
    try:
        return gdi.GetDeviceCaps(dc, 118) / u.GetSystemMetrics(0)  # DESKTOPHORZRES / SM_CXSCREEN
    finally:
        u.ReleaseDC(0, dc)
import comtypes.client
sys.stdout.reconfigure(encoding='utf-8')

comtypes.client.GetModule('UIAutomationCore.dll')
from comtypes.gen import UIAutomationClient as U  # noqa: E402

uia = comtypes.client.CreateObject(U.CUIAutomation, interface=U.IUIAutomation)
root = uia.GetRootElement()
stamp = lambda s: print(time.strftime('%H:%M:%S') + ' ' + s, flush=True)

def walk(el, depth=0, max_depth=14):
    yield el, depth
    if depth >= max_depth:
        return
    w = uia.RawViewWalker
    ch = w.GetFirstChildElement(el)
    while ch:
        yield from walk(ch, depth + 1, max_depth)
        ch = w.GetNextSiblingElement(ch)

def tops(cls_names):
    w = uia.RawViewWalker
    ch = w.GetFirstChildElement(root)
    while ch:
        if ch.CurrentClassName in cls_names:
            yield ch
        ch = w.GetNextSiblingElement(ch)

TRAY = ('Shell_TrayWnd', 'TopLevelWindowForOverflowXamlIsland', 'NotifyIconOverflowWindow')
u32 = ctypes.windll.user32
BRIDGE = 'Windows.UI.Composition.DesktopWindowContentBridge'

def bridges():
    """The XAML host inside each tray window. UIA's tree from the desktop root stops at Shell_TrayWnd's Win32 panes, but
    an element made from the bridge's own HWND walks into the XAML (taskbar buttons, tray icons, the overflow flyout)."""
    for cls in TRAY:
        top = u32.FindWindowW(cls, None)
        while top:
            b = u32.FindWindowExW(top, 0, BRIDGE, None)
            if b:
                yield cls, uia.ElementFromHandle(b)
            top = u32.FindWindowExW(None, top, cls, None)

def buttons():
    cond = uia.CreatePropertyCondition(U.UIA_ControlTypePropertyId, U.UIA_ButtonControlTypeId)
    for cls, el in bridges():
        arr = el.FindAll(U.TreeScope_Descendants, cond)
        for i in range(arr.Length):
            yield cls, arr.GetElement(i)

def find_toki(verbose=False):
    for cls, el in buttons():
        if verbose and el.CurrentAutomationId == 'SystemTrayIcon' or (verbose and cls != 'Shell_TrayWnd'):
            print('  [%s] tray button %r' % (cls, el.CurrentName.splitlines()[0] if el.CurrentName else ''))
        if el.CurrentName.startswith('Toki'):
            return cls, el
    return None, None

def find_chevron():
    for cls, el in buttons():
        if 'hidden icons' in (el.CurrentName or '').lower():
            return el
    return None

def invoke(el):
    el.GetCurrentPattern(U.UIA_InvokePatternId).QueryInterface(U.IUIAutomationInvokePattern).Invoke()

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'find'
    visible = lambda el: el is not None and el.CurrentBoundingRectangle.right > el.CurrentBoundingRectangle.left
    where, icon = find_toki(verbose=(mode == 'find'))
    # A hidden overflow icon is still in the tree, with an empty box: open the flyout first, then read it again.
    if icon is not None and not visible(icon):
        stamp('Toki icon is in the closed overflow flyout (empty box)')
    if not visible(icon):
        chev = find_chevron()
        stamp('opening the overflow chevron: %r' % (chev.CurrentName if chev else None))
        if chev:
            invoke(chev)
            time.sleep(0.4)
            where, icon = find_toki(verbose=(mode == 'find'))
    if not visible(icon):
        stamp('Toki tray icon: NOT FOUND (or not visible) through IUIAutomation')
        return 2
    # The flyout animates open: its icons' boxes grow and shrink for a moment. Wait for the same small box twice.
    box = lambda e: (e.CurrentBoundingRectangle.left, e.CurrentBoundingRectangle.top, e.CurrentBoundingRectangle.right, e.CurrentBoundingRectangle.bottom)
    prev, steady, deadline = None, False, time.time() + 1.5
    while time.time() < deadline:
        cur = box(icon)
        if cur == prev and 0 < cur[2] - cur[0] <= 60:
            steady = True
            break
        prev = cur
        time.sleep(0.08)
    r = icon.CurrentBoundingRectangle
    stamp('Toki tray icon: name=%r in %s, rect=(%d,%d)-(%d,%d) steady=%s' % (icon.CurrentName, where, r.left, r.top, r.right, r.bottom, steady))
    if mode != 'find' and not steady:
        stamp('the icon box never settled; no click sent')
        ctypes.windll.user32.keybd_event(0x1B, 0, 0, 0); ctypes.windll.user32.keybd_event(0x1B, 0, 2, 0)
        return 4
    if mode == 'find':
        if where != 'Shell_TrayWnd':
            ctypes.windll.user32.keybd_event(0x1B, 0, 0, 0); ctypes.windll.user32.keybd_event(0x1B, 0, 2, 0)
        return 0
    item_name = sys.argv[2]
    k = physical_scale()
    x, y = round((r.left + r.right) / 2 * k), round((r.top + r.bottom) / 2 * k)
    u = ctypes.windll.user32
    u.SetPhysicalCursorPos(x, y)
    u.mouse_event(0x0008, 0, 0, 0, 0)  # right down
    u.mouse_event(0x0010, 0, 0, 0, 0)  # right up
    stamp('one right click sent to the icon at physical (%d,%d), scale %.2f' % (x, y, k))
    target = None
    deadline = time.time() + 5
    while not target and time.time() < deadline:
        time.sleep(0.3)
        for menu in tops(('#32768',)):
            names = []
            for el, d in walk(menu, max_depth=3):
                if el.CurrentControlType == U.UIA_MenuItemControlTypeId:
                    names.append(el.CurrentName)
                    if el.CurrentName == item_name:
                        target = el
            stamp('tray menu (#32768) items via UIA: ' + ' | '.join(names))
    if not target:
        stamp('menu item %r NOT FOUND through UIA; Escape' % item_name)
        u.keybd_event(0x1B, 0, 0, 0); u.keybd_event(0x1B, 0, 2, 0)
        return 3
    invoke(target)
    stamp('invoked %r through UIA InvokePattern' % item_name)
    return 0

sys.exit(main())
