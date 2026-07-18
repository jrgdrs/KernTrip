# encoding: utf-8
# KernTrip.glyphsPlugin  ·  Optical kerning engine for Glyphs 3
# com.typobold.kerntrip
#
# IPC: JS navigates to kerntrip://cmd?data → WKNavigationDelegate intercepts & cancels.
# Python→JS: evaluateJavaScript (fire-and-forget).
# IS_GLYPHS detection: WKUserScript injects window.__IS_GLYPHS=true at document start.

from __future__ import print_function
import gc
import json
import objc
import os
import time
import traceback
import urllib.parse

# ── Crash-diagnostic logger ────────────────────────────────────────────────────
# Writes to /tmp/kerntrip_debug.txt so the log survives a hard Glyphs crash.
# Each line: timestamp  gc_enabled  gc_count  label
_DBG_PATH = '/tmp/kerntrip_debug.txt'

def _dbg(label):
    try:
        enabled  = gc.isenabled()
        count    = gc.get_count()
        thresh   = gc.get_threshold()
        msg = '[KernTrip-DBG %s] gc=%s count=%s thresh=%s :: %s\n' % (
            time.strftime('%H:%M:%S'), enabled, count, thresh, label)
        print(msg, end='')
        with open(_DBG_PATH, 'a') as f:
            f.write(msg)
    except Exception:
        pass
# ──────────────────────────────────────────────────────────────────────────────

from GlyphsApp import Glyphs, Message
try:
    from GlyphsApp.plugins import GeneralPlugin
except ImportError:
    from GlyphsApp import GeneralPlugin
try:
    from GlyphsApp.plugins import SCRIPT_MENU
except (ImportError, AttributeError):
    SCRIPT_MENU = 7

from AppKit import NSApp, NSMenuItem, NSObject, NSMakeRect, NSScreen

try:
    from AppKit import (NSWindowStyleMaskTitled, NSWindowStyleMaskClosable,
                        NSWindowStyleMaskResizable, NSWindowStyleMaskMiniaturizable,
                        NSBackingStoreBuffered)
except ImportError:
    NSWindowStyleMaskTitled         = 1
    NSWindowStyleMaskClosable       = 2
    NSWindowStyleMaskMiniaturizable = 4
    NSWindowStyleMaskResizable      = 8
    NSBackingStoreBuffered          = 2

from WebKit import WKWebView, WKWebViewConfiguration

GSOFFCURVE = 'offcurve'
GSLINE     = 'line'
GSCURVE    = 'curve'
GSQCURVE   = 'qcurve'


def _q2c(p0x, p0y, qx, qy, p2x, p2y):
    """Elevate a quadratic Bezier (p0, q, p2) to cubic control points."""
    return (
        p0x + 2.0 / 3 * (qx - p0x),
        p0y + 2.0 / 3 * (qy - p0y),
        p2x + 2.0 / 3 * (qx - p2x),
        p2y + 2.0 / 3 * (qy - p2y),
    )


# ── Path conversion ───────────────────────────────────────────────────────────

_IDENTITY_TRANSFORM = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def _apply_transform_to_nodes(nd_list, transform):
    m11, m12, m21, m22, tX, tY = transform
    return [(m11 * x + m21 * y + tX, m12 * x + m22 * y + tY, t)
            for (x, y, t) in nd_list]


def _compose_transforms(outer, inner):
    a11, a12, a21, a22, atX, atY = outer
    b11, b12, b21, b22, btX, btY = inner
    return (
        a11 * b11 + a21 * b12,
        a12 * b11 + a22 * b12,
        a11 * b21 + a21 * b22,
        a12 * b21 + a22 * b22,
        a11 * btX + a21 * btY + atX,
        a12 * btX + a22 * btY + atY,
    )


def _collect_layer_paths(layer, font, master_id, transform=None, depth=0):
    """Return list of node-lists for a layer, recursively resolving components."""
    if depth > 8:
        return []
    paths_py = []
    try:
        for path in (layer.paths or []):
            # str(nd.type) forces ObjC NSString → plain Python str so the
            # tuple contains no PyObjC proxies that could confuse the GC.
            nd_list = [(float(nd.x), float(nd.y), str(nd.type)) for nd in path.nodes]
            if nd_list:
                if transform is not None:
                    nd_list = _apply_transform_to_nodes(nd_list, transform)
                paths_py.append(nd_list)
    except Exception:
        pass
    try:
        for comp in (layer.components or []):
            try:
                ref_glyph = font.glyphs[str(comp.name)]  # str() avoids NSString proxy
                if ref_glyph is None:
                    continue
                ref_layer = ref_glyph.layers[master_id]
                if ref_layer is None:
                    continue
                try:
                    ct = tuple(float(v) for v in comp.transform)
                    if len(ct) != 6:
                        ct = _IDENTITY_TRANSFORM
                except Exception:
                    ct = _IDENTITY_TRANSFORM
                composed = _compose_transforms(transform, ct) if transform is not None else ct
                paths_py.extend(
                    _collect_layer_paths(ref_layer, font, master_id, composed, depth + 1))
            except Exception:
                pass
    except Exception:
        pass
    return paths_py


def _prefetch_layer_paths(layer):
    paths_py = []
    try:
        for path in layer.paths:
            nd_list = [(float(nd.x), float(nd.y), nd.type) for nd in path.nodes]
            if nd_list:
                paths_py.append(nd_list)
    except Exception:
        pass
    return paths_py


def _paths_to_js_commands(paths_py):
    commands = []
    for nodes in paths_py:
        n = len(nodes)
        if n < 2:
            continue
        oc_idx = [i for i, nd in enumerate(nodes) if nd[2] != GSOFFCURVE]
        if not oc_idx:
            continue
        num_oc = len(oc_idx)
        start = nodes[oc_idx[0]]
        commands.append({'type': 'M', 'x': start[0], 'y': -start[1]})
        for seg_i in range(num_oc):
            oc_s = oc_idx[seg_i]
            oc_e = oc_idx[(seg_i + 1) % num_oc]
            p0 = nodes[oc_s]
            seg = []
            i = (oc_s + 1) % n
            while True:
                seg.append(nodes[i])
                if i == oc_e:
                    break
                i = (i + 1) % n
            end_nd = seg[-1]
            offs   = seg[:-1]
            if end_nd[2] == GSLINE:
                commands.append({'type': 'L', 'x': end_nd[0], 'y': -end_nd[1]})
            elif end_nd[2] == GSCURVE and len(offs) == 2:
                commands.append({
                    'type': 'C',
                    'x1': offs[0][0], 'y1': -offs[0][1],
                    'x2': offs[1][0], 'y2': -offs[1][1],
                    'x':  end_nd[0],  'y':  -end_nd[1],
                })
            elif end_nd[2] == GSQCURVE:
                # Elevate TrueType quadratic segment(s) to cubic.
                # Multiple consecutive off-curves imply on-curve midpoints between them.
                if not offs:
                    commands.append({'type': 'L', 'x': end_nd[0], 'y': -end_nd[1]})
                else:
                    cur_x, cur_y = p0[0], p0[1]
                    for k, q in enumerate(offs):
                        if k < len(offs) - 1:
                            nx = (q[0] + offs[k + 1][0]) * 0.5
                            ny = (q[1] + offs[k + 1][1]) * 0.5
                        else:
                            nx, ny = end_nd[0], end_nd[1]
                        cp1x, cp1y, cp2x, cp2y = _q2c(cur_x, cur_y, q[0], q[1], nx, ny)
                        commands.append({
                            'type': 'C',
                            'x1': cp1x, 'y1': -cp1y,
                            'x2': cp2x, 'y2': -cp2y,
                            'x':  nx,   'y':  -ny,
                        })
                        cur_x, cur_y = nx, ny
        commands.append({'type': 'Z'})
    return commands


# ── Active-font resolution ────────────────────────────────────────────────────
# Glyphs.font relies on NSDocumentController.currentDocument, which returns None
# or a stale document while a non-document window — like the KernTrip panel — is
# main (exactly the moment the user clicks Compute).  The old fallback to the
# font captured at dialog-open time then silently loaded a background document.
# Walking NSApp.orderedWindows() front-to-back and taking the first visible
# window that belongs to a document with a font always yields the font of the
# document window the user sees as active.

def _resolve_active_font(fallback=None):
    try:
        for win in NSApp.orderedWindows():
            try:
                if not win.isVisible():
                    continue
                wc = win.windowController()
                if wc is None:
                    continue
                doc = wc.document()
                if doc is None or not doc.respondsToSelector_('font'):
                    continue
                font = doc.font()
                if font is not None:
                    return font
            except Exception:
                continue
    except Exception:
        traceback.print_exc()
    return Glyphs.font or fallback


# ── Navigation delegate (JS→Python IPC) ──────────────────────────────────────
# JS navigates to kerntrip://cmd?urlencoded_json.  Python intercepts, cancels the
# navigation, processes the command, then calls back via evaluateJavaScript.
# WKNavigationDelegate uses respondsToSelector: internally — no protocol
# conformance declaration needed; PyObjC exposes the method automatically.

class _KernTripNavDelegate(NSObject):
    _dialog       = None
    _pending_cmd   = ''
    _pending_query = ''

    def webView_decidePolicyForNavigationAction_decisionHandler_(
            self, webview, action, handler):
        """Called on the main thread by WKWebView for every navigation action.

        We cancel kerntrip:// navigations immediately and then defer the heavy
        Python work to the next runloop tick via performSelector:afterDelay:0.
        This unblocks the main runloop before _send_glyph_data() starts, which
        prevents the WebKit XPC channel from being flooded while the runloop is
        stalled — the root cause of crashes after several computing runs.
        """
        try:
            url    = action.request().URL()
            scheme = url.scheme() if url else None
            if scheme == 'kerntrip':
                handler(0)  # cancel immediately — page stays at file:// URL
                self._pending_cmd   = (url.host() or '').lower()
                self._pending_query = url.query() or ''
                print('[KernTrip] IPC cmd=%r (deferred)' % self._pending_cmd)
                if self._pending_cmd == 'applykerning':
                    _dbg('IPC:applykerning received in webView_handler — about to schedule kerntripDispatch_')
                # Cancel any still-queued dispatch before scheduling a new one.
                # Rapid IPC calls (e.g. double-click Load) must not stack
                # multiple _send_glyph_data calls on the runloop.
                NSObject.cancelPreviousPerformRequestsWithTarget_(self)
                self.performSelector_withObject_afterDelay_(
                    'kerntripDispatch:', None, 0.0)
                return
        except Exception:
            traceback.print_exc()
        handler(1)  # allow normal (non-kerntrip) navigations

    def kerntripDispatch_(self, _):
        """Runs in the next runloop cycle — main thread is free, XPC is healthy.

        gc.disable() guards the entire method: json.loads on large payloads creates
        tens of thousands of Python objects and reliably crosses the GC threshold.
        When GC fires inside an ObjC callback, visit_decref traverses KernTripDialog.__dict__
        (which holds live ObjC proxies) and crashes. Single-URL dispatch means
        gc.enable() in finally fires exactly once, after all ObjC work is complete.
        """
        gc.disable()
        try:
            cmd    = self._pending_cmd
            query  = self._pending_query
            dialog = self._dialog
            if not dialog:
                return
            # Guard against a stale dispatch firing after _cleanup() has run.
            if not getattr(dialog, '_webview', None):
                return
            try:
                if cmd == 'requestdata':
                    dialog._send_glyph_data()
                elif cmd == 'identify':
                    dialog._send_identity()
                elif cmd == 'applykerning':
                    _dbg('kerntripDispatch_:applykerning entry — query_len=%d' % len(query))
                    try:
                        payload = json.loads(urllib.parse.unquote(query)) if query else []
                    except Exception as pe:
                        print('[KernTrip] applykerning parse error: %s' % pe)
                        payload = []
                    # New format: {pairs: […], params: '…'} — params documents the
                    # run in Font Info. Old ui.html builds send a bare pairs array.
                    if isinstance(payload, dict):
                        pairs  = payload.get('pairs') or []
                        params = payload.get('params') or ''
                    else:
                        pairs, params = payload, ''
                    _dbg('kerntripDispatch_:applykerning json.loads done — pairs=%d' % len(pairs))
                    dialog._apply_kerning(pairs, params)
                    _dbg('kerntripDispatch_:applykerning _apply_kerning returned')
                elif cmd == 'applyspacing':
                    try:
                        payload = json.loads(urllib.parse.unquote(query)) if query else []
                    except Exception as pe:
                        print('[KernTrip] applyspacing parse error: %s' % pe)
                        payload = []
                    # New format: {items: […], unit: N} — unit is the module
                    # value for the master's unitizerUnit custom parameter.
                    # Old ui.html builds send a bare items array.
                    if isinstance(payload, dict):
                        items = payload.get('items') or []
                        unit  = payload.get('unit')
                    else:
                        items, unit = payload, None
                    dialog._apply_spacing(items, unit)
                elif cmd == 'note':
                    try:
                        payload = json.loads(urllib.parse.unquote(query)) if query else {}
                        lines = payload.get('lines') or []
                    except Exception as pe:
                        print('[KernTrip] note parse error: %s' % pe)
                        lines = []
                    dialog._append_note(lines)
                elif cmd == 'resize':
                    try:
                        params = dict(p.split('=') for p in query.split('&') if '=' in p)
                        w = int(params.get('w', 240))
                        h = int(params.get('h', 675))
                        dialog._resize_window(w, h)
                    except Exception as re:
                        print('[KernTrip] resize error: %s' % re)
            except Exception:
                traceback.print_exc()
        finally:
            gc.enable()


# ── Dialog ────────────────────────────────────────────────────────────────────

class KernTripDialog(object):

    def __init__(self):
        self._font         = _resolve_active_font()
        if not self._font:
            Message('No font open.', 'KernTrip')
            return
        self._webview      = None
        self._window       = None
        self._nav_delegate = None
        self._master_id    = None   # compute target, captured on every data load
        self._master_name  = None
        self._build_ui()

    def _cleanup(self):
        """Safely tear down WKWebView and window before the dialog is replaced."""
        nd = self._nav_delegate
        if nd is not None:
            try:
                # Cancel any pending kerntripDispatch: scheduled via
                # performSelector:afterDelay: so it cannot fire on a
                # torn-down dialog and crash in _send_glyph_data.
                NSObject.cancelPreviousPerformRequestsWithTarget_(nd)
            except Exception:
                pass
            try:
                nd._dialog = None   # break the back-reference / retain cycle
            except Exception:
                pass
        try:
            if self._webview:
                self._webview.setNavigationDelegate_(None)
                self._webview.stopLoading()
        except Exception:
            pass
        try:
            if self._window:
                self._window.close()
        except Exception:
            pass
        self._webview      = None
        self._nav_delegate = None
        self._window       = None

    @property
    def _master(self):
        """Selected master of the active document window — re-read on every access."""
        try:
            font = _resolve_active_font(self._font)
            return font.selectedFontMaster if font else None
        except Exception:
            return None

    def _build_ui(self):
        from AppKit import NSWindow, NSURL
        from WebKit import WKUserScript

        html_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ui.html')
        url       = NSURL.fileURLWithPath_(html_path)
        base_url  = NSURL.fileURLWithPath_(os.path.dirname(html_path) + os.sep)

        config = WKWebViewConfiguration.alloc().init()
        uc     = config.userContentController()

        # Inject IS_GLYPHS flag before page scripts run.
        flag_script = WKUserScript.alloc().initWithSource_injectionTime_forMainFrameOnly_(
            'window.__IS_GLYPHS = true;', 0, True)
        uc.addUserScript_(flag_script)

        # Open as a centered overlay at 82% of the screen, not a corner-anchored
        # panel — scales with display size instead of a fixed pixel default.
        screen  = (NSScreen.mainScreen() or NSScreen.screens()[0]).visibleFrame()
        win_w   = round(screen.size.width * 0.82)
        win_h   = round(screen.size.height * 0.82)
        win_x   = screen.origin.x + (screen.size.width - win_w) / 2.0
        win_y   = screen.origin.y + (screen.size.height - win_h) / 2.0
        rect    = NSMakeRect(win_x, win_y, win_w, win_h)
        self._webview = WKWebView.alloc().initWithFrame_configuration_(NSMakeRect(0, 0, win_w, win_h), config)

        nav_delegate         = _KernTripNavDelegate.alloc().init()
        nav_delegate._dialog = self
        self._nav_delegate   = nav_delegate          # strong ref
        self._webview.setNavigationDelegate_(nav_delegate)

        self._webview.loadFileURL_allowingReadAccessToURL_(url, base_url)

        style = (NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                 NSWindowStyleMaskResizable | NSWindowStyleMaskMiniaturizable)
        win = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            rect, style, NSBackingStoreBuffered, False)
        master = self._master
        win.setTitle_('KernTrip  ·  %s  ·  %s' % (
            self._font.familyName or 'Untitled',
            master.name if master else 'Master'))
        win.setReleasedWhenClosed_(False)   # keep ObjC object alive; we manage lifetime
        win.setMinSize_((220, 300))
        win.setContentView_(self._webview)
        win.makeKeyAndOrderFront_(None)
        self._window = win
        print('[KernTrip] window ready')

    def _js(self, code):
        self._webview.evaluateJavaScript_completionHandler_(code, None)

    def _resize_window(self, w, h):
        try:
            if not self._window:
                return
            f = self._window.frame()
            # Keep top-left corner fixed; macOS Y origin is bottom of screen
            new_h = h + 22   # approximate titlebar height
            new_origin_y = f.origin.y + f.size.height - new_h
            from AppKit import NSMakeRect
            self._window.setMinSize_((w, h))
            self._window.setFrame_display_animate_(
                NSMakeRect(f.origin.x, new_origin_y, w, new_h), True, True)
        except Exception:
            traceback.print_exc()

    def _send_identity(self):
        try:
            font = _resolve_active_font(self._font)
            if not font:
                return
            self._font = font
            master = font.selectedFontMaster
            fn = font.familyName or 'Untitled'
            mn = (master.name if master else 'Master')
            n  = len(list(font.glyphs))
            print('[KernTrip] identify: %s / %s / %d glyphs' % (fn, mn, n))
            # json.dumps produces a properly escaped JS string literal that
            # handles backslashes, quotes, control chars and non-ASCII safely.
            self._js('setFontInfo(%s,%s,%d)' % (json.dumps(fn), json.dumps(mn), n))
        except Exception:
            traceback.print_exc()

    def _send_glyph_data(self):
        # Python's cyclic GC can crash when it traverses PyObjC proxy objects
        # (GSGlyph, GSLayer, GSNode …) that are live on the stack: ObjC's ARC
        # retains are invisible to gc_refs accounting, so visit_decref can push
        # gc_refs below zero → abort.  Disable the cyclic GC for the duration
        # so it cannot fire mid-traversal while ObjC proxies are alive.
        # Do NOT call gc.collect() here — we are already inside an ObjC callback
        # (method_stub), so an explicit collect would crash for the same reason.
        gc.disable()
        try:
            self._send_glyph_data_inner()
        finally:
            gc.enable()

    def _send_glyph_data_inner(self):
        try:
            # Always resolve font and master together from the frontmost document
            # window so master_id is guaranteed to belong to this font.  Using
            # self._font with a master from a different font (e.g. two fonts open)
            # would make layer lookups by master_id return None for every glyph
            # → silent skip or, in older Glyphs builds, an ObjC exception → crash.
            font = _resolve_active_font(self._font)
            if not font:
                return
            master = font.selectedFontMaster
            if not master:
                return
            self._font = font   # refresh so _master property stays consistent
            master_id = master.id
            # Remember the compute target so Apply later writes into exactly
            # this font/master even if another document becomes active meanwhile.
            self._master_id   = master_id
            self._master_name = master.name or 'Master'
            all_glyphs = list(font.glyphs)
            n_all      = len(all_glyphs)

            # Reflect current master in window title
            try:
                self._window.setTitle_('KernTrip  ·  %s  ·  %s' % (
                    font.familyName or 'Untitled', master.name or 'Master'))
            except Exception:
                pass

            print('[KernTrip] _send_glyph_data: %s / %s / %d glyphs' % (
                font.familyName, master.name, n_all))

            self._js('dbg("Python: reading %d glyphs…")' % n_all)
            self._js('setLoadProgress(2,"Reading glyph data from Glyphs…")')

            glyphs_data = []
            skipped     = 0

            for idx, glyph in enumerate(all_glyphs):
                try:
                    layer = glyph.layers[master_id]
                    if layer is None:
                        skipped += 1
                        continue
                    paths_py = _collect_layer_paths(layer, font, master_id)
                    if not paths_py:
                        skipped += 1
                        continue
                    commands = _paths_to_js_commands(paths_py)
                    if not commands:
                        skipped += 1
                        continue
                    uni = None
                    if glyph.unicode:
                        try:    uni = int(glyph.unicode, 16)
                        except (ValueError, TypeError): pass
                    glyphs_data.append({
                        'name':         str(glyph.name),
                        'advanceWidth': float(layer.width or 0),
                        'unicode':      uni,
                        'commands':     commands,
                    })
                except Exception:
                    skipped += 1

                if (idx + 1) % 50 == 0 or (idx + 1) == n_all:
                    pct = int((idx + 1) / n_all * 28) + 2
                    msg = 'Reading %d / %d glyphs…' % (idx + 1, n_all)
                    print('[KernTrip] ' + msg)
                    self._js('setLoadProgress(%d,"%s")' % (pct, msg))

            print('[KernTrip] serialized %d glyphs (%d skipped)' % (len(glyphs_data), skipped))
            self._js('setLoadProgress(32,"Serializing JSON…")')

            # space/nbspace have no outline, so the loop above always skips
            # them (paths_py empty) — resolve name + current width directly
            # (name first, Glyphs' own canonical naming; unicode as fallback
            # for custom-named glyphs) so Spacing Corrections can size them
            # off "i" (09-spacing.js / applySpacingToGlyphs in 07-output.js).
            space_glyphs = {}
            for key, gname, uni_hex in (('sp', 'space', '0020'), ('nbsp', 'nbspace', '00A0')):
                g = font.glyphs[gname]
                if g is None:
                    for cand in all_glyphs:
                        if (cand.unicode or '').upper() == uni_hex:
                            g = cand
                            break
                if g is None:
                    continue
                layer = g.layers[master_id]
                if layer is None:
                    continue
                space_glyphs[key] = {'name': str(g.name), 'advanceWidth': float(layer.width or 0)}

            xh = getattr(master, 'xHeight', None)
            data = {
                'upm':         float(font.upm),
                'yBot':        float(master.descender),
                'yTop':        float(master.ascender),
                'xHeight':     float(xh) if xh else None,
                'fontName':    font.familyName or '',
                'masterName':  master.name     or '',
                'glyphs':      glyphs_data,
                'spaceGlyphs': space_glyphs,
            }
            json_str = json.dumps(data)
            kb = len(json_str) // 1024
            print('[KernTrip] JSON: %d KB, sending to WebView…' % kb)
            self._js('setLoadProgress(35,"Sending %d KB to WebView…")' % kb)

            self._webview.evaluateJavaScript_completionHandler_(
                'receiveGlyphData(%s)' % json_str, None)
            print('[KernTrip] receiveGlyphData dispatched')
        except Exception:
            traceback.print_exc()
            self._js('dbg("Python ERROR in _send_glyph_data — check Glyphs console")')

    def _apply_target(self):
        """Font/master the last compute ran on — Apply must write there, not
        into whatever document happens to be active at apply time."""
        font   = self._font
        master = None
        if font is not None and self._master_id:
            try:
                for m in font.masters:
                    if m.id == self._master_id:
                        master = m
                        break
            except Exception:
                master = None
        if master is None:          # no compute yet, or master was deleted
            master = self._master
        return font, master

    def _apply_kerning(self, pairs, params=''):
        try:
            _dbg('_apply_kerning entry — pairs=%d' % len(pairs))
            if not pairs:
                return
            font, master = self._apply_target()
            if font is None or master is None:
                return
            from AppKit import NSAlert, NSAlertFirstButtonReturn
            _dbg('_apply_kerning — building NSAlert')
            alert = NSAlert.alloc().init()
            alert.setMessageText_('Apply Kerning — %s' % master.name)
            alert.setInformativeText_(
                'Write %d non-zero pairs into master "%s" of "%s"?\n\n'
                'Existing kerning for this master will be replaced.' % (
                    len(pairs), master.name, font.familyName or 'Untitled'))
            alert.addButtonWithTitle_('Apply')
            alert.addButtonWithTitle_('Cancel')
            _dbg('_apply_kerning — calling runModal')
            if alert.runModal() != NSAlertFirstButtonReturn:
                _dbg('_apply_kerning — user cancelled')
                return

            _dbg('_apply_kerning — user confirmed, starting font write')
            master_id = master.id
            ok        = 0
            try:   font.disableUpdateInterface()
            except AttributeError: pass
            try:
                try:    del font.kerning[master_id]
                except (KeyError, Exception): pass
                _dbg('_apply_kerning — kerning dict cleared, writing %d pairs' % len(pairs))
                for pair in pairs:
                    try:
                        font.setKerningForPair(
                            master_id, pair['left'], pair['right'], int(pair['correction']))
                        ok += 1
                    except Exception as e:
                        print('[KernTrip] pair %s %s: %s' % (
                            pair.get('left', '?'), pair.get('right', '?'), e))
            finally:
                try:   font.enableUpdateInterface()
                except AttributeError: pass

            summary = 'Applied %d pairs → master "%s" (%s).' % (
                ok, master.name, font.familyName or 'Untitled')
            _dbg('_apply_kerning — done: ' + summary)
            print('[KernTrip] ' + summary)
            self._document_run(master, ok, params)
            self._webview.evaluateJavaScript_completionHandler_(
                'showApplyResult && showApplyResult(%s)' % json.dumps({'ok': ok, 'msg': summary}),
                None)
            Message(summary, 'KernTrip — Done')
            # Kerning assigned to the font — close the window. Runs on a
            # fresh runloop tick (kerntripDispatch_'s deferred dispatch), not
            # nested inside a WKWebView navigation callback, so _cleanup()'s
            # webview/window teardown is safe here (see openKernTrip_, the
            # only other caller).
            if ok > 0:
                self._cleanup()
        except Exception:
            _dbg('_apply_kerning — EXCEPTION (see traceback below)')
            traceback.print_exc()

    def _document_run(self, master, ok, params):
        """Document the apply run in Font Info (Cmd-I):
        - 'KernTrip Last Run' custom parameter on the master (Masters tab),
          replaced on every run;
        - one line appended to Font Info → Notes (font.note), never replaced,
          so the notes accumulate a run history across masters."""
        stamp = time.strftime('%Y-%m-%d %H:%M')
        entry = '%s — %d pairs' % (stamp, ok)
        if params:
            entry += ' — ' + params
        try:
            master.customParameters['KernTrip Last Run'] = entry
        except Exception:
            traceback.print_exc()
        try:
            font = self._font
            line = '[KernTrip] %s — Master "%s" — %d pairs%s' % (
                stamp, master.name, ok, (' — ' + params) if params else '')
            note = font.note or ''
            font.note = (note.rstrip() + '\n' + line) if note.strip() else line
            print('[KernTrip] run documented: ' + line)
        except Exception:
            traceback.print_exc()

    def _append_note(self, lines):
        """Append a multi-line documentation block (e.g. the AutoParam result:
        timestamp, max-equilibrium, palette parameters) to Font Info → Notes —
        appended like _document_run, never replaced."""
        try:
            if not lines:
                return
            font = self._font
            if font is None:
                return
            block = '\n'.join(str(l) for l in lines)
            note  = font.note or ''
            font.note = (note.rstrip() + '\n' + block) if note.strip() else block
            print('[KernTrip] note appended: %s' % lines[0])
        except Exception:
            traceback.print_exc()

    def _apply_spacing(self, items, unit=None):
        try:
            if not items:
                return
            font, master = self._apply_target()
            if font is None or master is None:
                return
            from AppKit import NSAlert, NSAlertFirstButtonReturn
            alert = NSAlert.alloc().init()
            alert.setMessageText_('Apply Spacing — %s' % master.name)
            alert.setInformativeText_(
                'Set advance width and left sidebearing for %d glyphs in master "%s" of "%s"?\n\n'
                'This overwrites the current horizontal metrics.' % (
                    len(items), master.name, font.familyName or 'Untitled'))
            alert.addButtonWithTitle_('Apply')
            alert.addButtonWithTitle_('Cancel')
            if alert.runModal() != NSAlertFirstButtonReturn:
                return

            master_id = master.id
            ok        = 0
            try:   font.disableUpdateInterface()
            except AttributeError: pass
            try:
                for item in items:
                    try:
                        glyph = font.glyphs[item['name']]
                        if glyph is None:
                            continue
                        layer = glyph.layers[master_id]
                        if layer is None:
                            continue
                        layer.width = int(round(layer.width + item['dwidth']))
                        layer.LSB   = int(round(layer.LSB   + item['dlsb']))
                        ok += 1
                    except Exception as e:
                        print('[KernTrip] spacing %s: %s' % (item.get('name', '?'), e))
            finally:
                try:   font.enableUpdateInterface()
                except AttributeError: pass

            summary = 'Applied spacing for %d glyphs → master "%s" (%s).' % (
                ok, master.name, font.familyName or 'Untitled')

            # Document the module on the master: assignment to customParameters
            # updates an existing unitizerUnit or creates it if missing.
            if unit is not None:
                try:
                    master.customParameters['unitizerUnit'] = int(unit)
                    summary += ' unitizerUnit = %d.' % int(unit)
                except Exception:
                    traceback.print_exc()

            print('[KernTrip] ' + summary)
            self._webview.evaluateJavaScript_completionHandler_(
                'showSpacingApplyResult && showSpacingApplyResult(%s)' % json.dumps(
                    {'ok': ok, 'msg': summary}),
                None)
            Message(summary, 'KernTrip — Done')
            # Spacing assigned to the font — close the window (see the
            # matching comment in _apply_kerning for why this is safe here).
            if ok > 0:
                self._cleanup()
        except Exception:
            traceback.print_exc()


# ── Plugin entry point ────────────────────────────────────────────────────────

class KernTripPlugin(GeneralPlugin):

    @objc.python_method
    def settings(self):
        self.name = 'KernTrip'

    @objc.python_method
    def start(self):
        item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
            'KernTrip…', 'openKernTrip:', '')
        item.setTarget_(self)
        Glyphs.menu[SCRIPT_MENU].append(item)
        self._dialog = None

    def openKernTrip_(self, sender):
        try:
            if (self._dialog is not None
                    and hasattr(self._dialog, '_window')
                    and self._dialog._window is not None
                    and self._dialog._window.isVisible()):
                self._dialog._window.makeKeyAndOrderFront_(None)
                return
        except Exception:
            pass
        # Nil out the nav delegate before the old dialog is GC'd; WKWebView holds
        # a weak navigationDelegate pointer and a dangling ref causes a crash.
        if self._dialog is not None:
            try:
                self._dialog._cleanup()
            except Exception:
                pass
        self._dialog = None
        self._dialog = KernTripDialog()

    def __del__(self):
        pass
