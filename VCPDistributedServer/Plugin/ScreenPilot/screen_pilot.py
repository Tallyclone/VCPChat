# -*- coding: utf-8 -*-
"""
ScreenPilot - VCP 屏幕视觉与操控插件
功能：截图(ScreenCapture)、点击模拟(ClickAt)、UI元素探测(InspectUI)
"""

import sys
import json
import os
import io
import base64
import time
import re
import traceback
from datetime import datetime

# ============================================================
# Windows DPI 感知声明（必须在任何 Win32 API 调用前执行）
# 不声明的话，GetWindowRect 等 API 在高 DPI 系统上返回缩放后的
# 逻辑坐标，导致截图尺寸不对、点击坐标偏移。
# ============================================================
import ctypes
try:
    # PROCESS_PER_MONITOR_DPI_AWARE = 2
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        # 降级到 SetProcessDPIAware（Vista+）
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


# ============================================================
# 工具函数
# ============================================================

def debug_log(msg):
    """调试日志写入 stderr（不会被主服务读取为 stdout 结果）"""
    sys.stderr.write(f"[ScreenPilot DEBUG] {msg}\n")
    sys.stderr.flush()


def output_result(status, result=None, error=None):
    """将结果以 JSON 打印到 stdout，遵循 VCP 同步插件规范"""
    payload = {"status": status}
    if result is not None:
        payload["result"] = result
    if error is not None:
        payload["error"] = error
    # 使用 UTF-8 直接写入 stdout 字节流，避免编码问题
    json_str = json.dumps(payload, ensure_ascii=False)
    stdout_bytes = json_str.encode("utf-8")
    sys.stdout.buffer.write(stdout_bytes)
    sys.stdout.buffer.write(b"\n")
    sys.stdout.buffer.flush()


def get_screenshot_dir():
    """获取截图存储目录"""
    env_dir = os.environ.get("SCREENSHOT_DIR", "").strip()
    if env_dir:
        d = env_dir
    else:
        d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "screenshots")
    os.makedirs(d, exist_ok=True)
    return d


def normalize_args(args):
    """处理参数同义词和大小写兼容"""
    lower = {k.lower(): v for k, v in args.items()}
    return lower


# ============================================================
# OCR 引擎（延迟加载单例）
# ============================================================

_ocr_engine = None

def get_ocr_engine():
    """延迟加载 RapidOCR 引擎（单例），避免重复初始化"""
    global _ocr_engine
    if _ocr_engine is None:
        from rapidocr_onnxruntime import RapidOCR
        _ocr_engine = RapidOCR()
        debug_log("RapidOCR 引擎已初始化")
    return _ocr_engine


def run_ocr(img, window_rect=None):
    """
    对 PIL Image 运行 OCR，返回检测到的文本块列表。
    每个文本块包含: text, boundingBox, clickablePoint
    如果提供了 window_rect，clickablePoint 会使用屏幕绝对坐标。
    """
    import numpy as np
    from PIL import ImageFilter, ImageEnhance
    engine = get_ocr_engine()

    # 屏幕截图预处理：放大 + 锐化，显著提升小字和中文的识别率
    img_rgb = img.convert("RGB")
    orig_w, orig_h = img_rgb.size
    scale = 1.0

    # 如果图像较小（常见于窗口截图），放大 2 倍
    if orig_w < 2560 or orig_h < 1440:
        scale = 2.0
        img_rgb = img_rgb.resize((int(orig_w * scale), int(orig_h * scale)), resample=3)  # BICUBIC

    # 锐化 + 轻微对比度增强，对抗屏幕抗锯齿
    img_rgb = img_rgb.filter(ImageFilter.SHARPEN)
    img_rgb = ImageEnhance.Contrast(img_rgb).enhance(1.3)

    img_array = np.array(img_rgb)

    result, _ = engine(img_array)
    if not result:
        return []

    text_blocks = []
    for item in result:
        # item: [bbox_points, text, confidence]
        # bbox_points: [[x1,y1],[x2,y2],[x3,y3],[x4,y4]] 四个角点
        bbox_points = item[0]
        text = item[1]
        confidence = item[2]

        # 计算轴对齐边界框（OCR 坐标基于放大后的图像，需缩回原图）
        xs = [p[0] / scale for p in bbox_points]
        ys = [p[1] / scale for p in bbox_points]
        x_min, x_max = int(min(xs)), int(max(xs))
        y_min, y_max = int(min(ys)), int(max(ys))

        # 原图内坐标的中心点
        center_x = (x_min + x_max) // 2
        center_y = (y_min + y_max) // 2

        block = {
            "text": text,
            "confidence": round(float(confidence), 3),
            "boundingBox": {
                "x": x_min, "y": y_min,
                "width": x_max - x_min, "height": y_max - y_min
            },
            # 图像内的像素坐标（原图尺寸）
            "imagePoint": {"x": center_x, "y": center_y},
        }

        # 计算屏幕绝对坐标的点击位置
        if window_rect:
            block["clickablePoint"] = {
                "x": window_rect["x"] + center_x,
                "y": window_rect["y"] + center_y
            }
        else:
            # 全屏截图时，图像坐标 = 屏幕坐标
            block["clickablePoint"] = {"x": center_x, "y": center_y}

        text_blocks.append(block)

    return text_blocks


# ============================================================
# ScreenCapture 指令
# ============================================================

def find_window_by_title(title_keyword):
    """根据标题关键字模糊匹配窗口，返回 (hwnd, full_title)"""
    import win32gui

    results = []

    def enum_callback(hwnd, _):
        if win32gui.IsWindowVisible(hwnd):
            t = win32gui.GetWindowText(hwnd)
            if t and title_keyword.lower() in t.lower():
                results.append((hwnd, t))

    win32gui.EnumWindows(enum_callback, None)
    if not results:
        return None, None
    # 优先返回标题最短的（最匹配的）
    results.sort(key=lambda x: len(x[1]))
    return results[0]


def capture_window_by_hwnd(hwnd):
    """通过 Win32 API 截取指定窗口的图像，返回 PIL Image"""
    import win32gui
    import win32ui
    import win32con
    from PIL import Image

    # 获取窗口尺寸
    left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    width = right - left
    height = bottom - top

    if width <= 0 or height <= 0:
        raise ValueError(f"窗口尺寸无效: {width}x{height}")

    # 创建设备上下文
    hwnd_dc = win32gui.GetWindowDC(hwnd)
    mfc_dc = win32ui.CreateDCFromHandle(hwnd_dc)
    save_dc = mfc_dc.CreateCompatibleDC()

    # 创建位图
    bitmap = win32ui.CreateBitmap()
    bitmap.CreateCompatibleBitmap(mfc_dc, width, height)
    save_dc.SelectObject(bitmap)

    # 使用 PrintWindow 捕获（支持部分遮挡的窗口）
    # PW_RENDERFULLCONTENT = 2, 能截取 DWM 合成的内容
    try:
        result = win32gui.SendMessage(hwnd, win32con.WM_PRINT, save_dc.GetSafeHdc(),
                                       win32con.PRF_CHILDREN | win32con.PRF_CLIENT | win32con.PRF_NONCLIENT)
    except Exception:
        pass

    # 回退到 PrintWindow
    import ctypes
    ctypes.windll.user32.PrintWindow(hwnd, save_dc.GetSafeHdc(), 2)

    # 转换为 PIL Image
    bmp_info = bitmap.GetInfo()
    bmp_bits = bitmap.GetBitmapBits(True)

    img = Image.frombuffer("RGB", (bmp_info["bmWidth"], bmp_info["bmHeight"]),
                           bmp_bits, "raw", "BGRX", 0, 1)

    # 清理资源
    win32gui.DeleteObject(bitmap.GetHandle())
    save_dc.DeleteDC()
    mfc_dc.DeleteDC()
    win32gui.ReleaseDC(hwnd, hwnd_dc)

    return img


def capture_fullscreen():
    """全屏截图，返回 PIL Image"""
    import pyautogui
    return pyautogui.screenshot()


def image_to_base64(img, fmt="PNG"):
    """将 PIL Image 转为 base64 Data URI"""
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
    mime = "image/png" if fmt.upper() == "PNG" else "image/jpeg"
    return f"data:{mime};base64,{b64}"


def cmd_screen_capture(args):
    """执行 ScreenCapture 指令"""
    a = normalize_args(args)

    hwnd = a.get("hwnd")
    window_title = a.get("windowtitle") or a.get("window_title") or a.get("title")
    save = str(a.get("save", "false")).lower() in ("true", "1", "yes")
    do_ocr = str(a.get("ocr", "false")).lower() in ("true", "1", "yes")
    filename = a.get("filename")

    captured_title = None
    img = None
    window_rect = None  # 窗口在屏幕上的位置，用于坐标换算

    if hwnd:
        hwnd = int(hwnd)
        import win32gui
        captured_title = win32gui.GetWindowText(hwnd) or f"HWND:{hwnd}"
        left, top, right, bottom = win32gui.GetWindowRect(hwnd)
        window_rect = {"x": left, "y": top, "width": right - left, "height": bottom - top}
        img = capture_window_by_hwnd(hwnd)
    elif window_title:
        found_hwnd, found_title = find_window_by_title(window_title)
        if found_hwnd is None:
            return {"status": "error", "error": f"未找到标题包含 '{window_title}' 的窗口。请检查窗口是否已打开。"}
        captured_title = found_title
        import win32gui
        left, top, right, bottom = win32gui.GetWindowRect(found_hwnd)
        window_rect = {"x": left, "y": top, "width": right - left, "height": bottom - top, "hwnd": found_hwnd}
        img = capture_window_by_hwnd(found_hwnd)
    else:
        img = capture_fullscreen()
        captured_title = "全屏截图"

    width, height = img.size
    data_uri = image_to_base64(img)

    text_parts = [
        f"截图成功: {captured_title}",
        f"分辨率: {width} × {height} 像素",
    ]
    if window_rect:
        text_parts.append(
            f"窗口屏幕位置: 左上角({window_rect['x']}, {window_rect['y']})  "
            f"尺寸 {window_rect['width']}×{window_rect['height']}"
        )
        text_parts.append(
            "提示: 截图中的像素坐标 + 窗口左上角坐标 = 屏幕绝对坐标，"
            "或在 ClickAt 中使用 relativeToWindow=true + hwnd 直接传窗口相对坐标。"
        )

    # 持久化保存
    saved_path = None
    if save:
        screenshot_dir = get_screenshot_dir()
        if not filename:
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            safe_title = re.sub(r'[<>:"/\\|?*]', '_', (captured_title or "screenshot")[:30])
            filename = f"{safe_title}_{ts}.png"
        save_path = os.path.join(screenshot_dir, filename)
        img.save(save_path, "PNG")
        saved_path = save_path
        text_parts.append(f"已保存到: {save_path}")

    # OCR 文本检测
    ocr_blocks = None
    if do_ocr:
        try:
            ocr_blocks = run_ocr(img, window_rect)
            text_parts.append(f"\nOCR 检测到 {len(ocr_blocks)} 个文本区域:")
            for i, blk in enumerate(ocr_blocks, 1):
                cp = blk["clickablePoint"]
                text_parts.append(
                    f"  [{i}] \"{blk['text']}\" → 点击({cp['x']},{cp['y']}) "
                    f"置信度:{blk['confidence']}"
                )
        except Exception as e:
            debug_log(f"OCR 失败: {e}")
            text_parts.append(f"\nOCR 检测失败: {e}")

    result = {
        "content": [
            {"type": "text", "text": "\n".join(text_parts)},
            {"type": "image_url", "image_url": {"url": data_uri}}
        ],
        "resolution": {"width": width, "height": height},
    }
    if window_rect:
        result["windowRect"] = window_rect
    if saved_path:
        result["savedPath"] = saved_path
    if ocr_blocks is not None:
        result["ocrResults"] = ocr_blocks

    return {"status": "success", "result": result}


# ============================================================
# ClickAt 指令
# ============================================================

def cmd_click_at(args):
    """执行 ClickAt 指令"""
    import pyautogui
    a = normalize_args(args)

    x = a.get("x")
    y = a.get("y")
    if x is None or y is None:
        return {"status": "error", "error": "必须提供 x 和 y 坐标参数。"}

    x = int(x)
    y = int(y)
    button = str(a.get("button", "left")).lower()
    clicks = int(a.get("clicks", 1))
    hwnd = a.get("hwnd")
    # relativeToWindow: 当为 true 且提供了 hwnd 时，(x,y) 被视为窗口内相对坐标
    relative_to_window = str(a.get("relativetowindow") or a.get("relative_to_window") or a.get("relative") or "false").lower() in ("true", "1", "yes")

    if button not in ("left", "right", "middle"):
        return {"status": "error", "error": f"无效的button参数: '{button}'，可选值: left, right, middle。"}

    coord_mode = "屏幕绝对"

    # 如果提供了 hwnd，先置前窗口
    if hwnd:
        hwnd = int(hwnd)
        try:
            import win32gui
            import win32con
            # 尝试恢复最小化的窗口
            if win32gui.IsIconic(hwnd):
                win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
            win32gui.SetForegroundWindow(hwnd)
            time.sleep(0.3)  # 等待窗口切换完成

            # 如果是窗口相对坐标模式，将 (x,y) 转换为屏幕绝对坐标
            if relative_to_window:
                win_left, win_top, _, _ = win32gui.GetWindowRect(hwnd)
                orig_x, orig_y = x, y
                x = win_left + x
                y = win_top + y
                coord_mode = f"窗口相对({orig_x},{orig_y}) → 屏幕绝对"
        except Exception as e:
            debug_log(f"SetForegroundWindow failed: {e}")
            if relative_to_window:
                return {"status": "error", "error": f"无法获取窗口位置进行坐标转换: {e}"}

    elif relative_to_window:
        return {"status": "error", "error": "使用 relativeToWindow 时必须同时提供 hwnd 参数。"}

    # 获取屏幕尺寸用于安全检查
    screen_w, screen_h = pyautogui.size()
    if x < 0 or x >= screen_w or y < 0 or y >= screen_h:
        return {
            "status": "error",
            "error": f"最终屏幕坐标 ({x}, {y}) 超出屏幕范围 ({screen_w}×{screen_h})。"
        }

    # 执行点击
    pyautogui.click(x, y, button=button, clicks=clicks)

    result_text = f"已在{coord_mode}坐标 ({x}, {y}) 执行 {button} 键点击 {clicks} 次。"
    if hwnd:
        result_text += f"\n(已先将窗口 HWND:{hwnd} 置于前台)"

    return {
        "status": "success",
        "result": result_text
    }


# ============================================================
# InspectUI 指令
# ============================================================

def cmd_inspect_ui(args):
    """执行 InspectUI 指令 — 通过 Windows UI Automation 获取窗口内可交互元素"""
    import uiautomation as auto
    a = normalize_args(args)

    hwnd = a.get("hwnd")
    window_title = a.get("windowtitle") or a.get("window_title") or a.get("title")
    control_type_filter = a.get("controltype") or a.get("control_type") or a.get("type")
    max_depth = int(a.get("maxdepth") or a.get("max_depth") or 5)
    max_items = int(a.get("maxitems") or a.get("max_items") or 50)

    # 找到目标窗口
    target_window = None
    actual_title = None

    if hwnd:
        hwnd = int(hwnd)
        target_window = auto.ControlFromHandle(hwnd)
        if target_window:
            actual_title = target_window.Name or f"HWND:{hwnd}"
    elif window_title:
        # 通过 win32gui 精确查找
        found_hwnd, found_title = find_window_by_title(window_title)
        if found_hwnd:
            target_window = auto.ControlFromHandle(found_hwnd)
            actual_title = found_title
    else:
        return {"status": "error", "error": "必须提供 windowTitle 或 hwnd 参数来指定要检查的窗口。"}

    if target_window is None:
        return {"status": "error", "error": f"未找到目标窗口。搜索条件: title='{window_title}', hwnd={hwnd}"}

    # 定义要收集的可交互控件类型
    interactive_types = {
        "ButtonControl", "EditControl", "MenuItemControl", "CheckBoxControl",
        "RadioButtonControl", "ComboBoxControl", "HyperlinkControl",
        "ListItemControl", "TreeItemControl", "TabItemControl",
        "SliderControl", "SpinnerControl", "ToolBarControl",
        "MenuBarControl", "DataItemControl", "ScrollBarControl"
    }

    # 控件类型名映射（用于筛选）
    type_name_map = {
        "button": "ButtonControl",
        "edit": "EditControl",
        "menuitem": "MenuItemControl",
        "checkbox": "CheckBoxControl",
        "radiobutton": "RadioButtonControl",
        "combobox": "ComboBoxControl",
        "hyperlink": "HyperlinkControl",
        "listitem": "ListItemControl",
        "treeitem": "TreeItemControl",
        "tabitem": "TabItemControl",
        "slider": "SliderControl",
        "spinner": "SpinnerControl",
        "toolbar": "ToolBarControl",
    }

    # 解析用户的控件类型筛选
    filter_control_class = None
    if control_type_filter:
        cf = control_type_filter.lower().replace(" ", "")
        if cf in type_name_map:
            filter_control_class = type_name_map[cf]
        elif cf + "control" in {t.lower() for t in interactive_types}:
            # 直接匹配如 "ButtonControl"
            for t in interactive_types:
                if t.lower() == cf + "control" or t.lower() == cf:
                    filter_control_class = t
                    break
        else:
            filter_control_class = control_type_filter  # 原样传递，后续匹配

    # 递归遍历 UI 树
    elements = []

    def walk(control, depth):
        if depth > max_depth or len(elements) >= max_items:
            return

        control_type_name = control.ControlTypeName

        # 检查是否是可交互元素
        is_interactive = control_type_name in interactive_types

        if is_interactive:
            # 如果有筛选条件，检查是否匹配
            if filter_control_class:
                if control_type_name.lower() != filter_control_class.lower():
                    pass  # 不添加，但继续遍历子元素
                else:
                    add_element(control, control_type_name)
            else:
                add_element(control, control_type_name)

        # 遍历子元素
        if depth < max_depth and len(elements) < max_items:
            try:
                children = control.GetChildren()
                for child in children:
                    if len(elements) >= max_items:
                        break
                    walk(child, depth + 1)
            except Exception:
                pass

    def add_element(control, control_type_name):
        if len(elements) >= max_items:
            return
        try:
            rect = control.BoundingRectangle
            # 某些不可见元素的 rect 全为 0
            if rect.width() <= 0 and rect.height() <= 0:
                return

            name = control.Name or ""
            # 计算中心点作为可点击坐标
            center_x = rect.left + rect.width() // 2
            center_y = rect.top + rect.height() // 2

            elem_info = {
                "name": name,
                "controlType": control_type_name.replace("Control", ""),
                "boundingRect": {
                    "x": rect.left,
                    "y": rect.top,
                    "width": rect.width(),
                    "height": rect.height()
                },
                "clickablePoint": {"x": center_x, "y": center_y},
                "isEnabled": control.IsEnabled,
            }

            # 尝试获取值（对编辑框等有用）
            try:
                vp = control.GetValuePattern()
                if vp:
                    elem_info["value"] = vp.Value[:100] if vp.Value else ""
            except Exception:
                pass

            elements.append(elem_info)
        except Exception as e:
            debug_log(f"跳过元素: {e}")

    walk(target_window, 0)

    # 构建结果
    text_lines = [
        f"UI Automation 检查结果: {actual_title}",
        f"找到 {len(elements)} 个可交互元素" + (f" (类型筛选: {control_type_filter})" if control_type_filter else ""),
        f"遍历深度: {max_depth}",
        "",
    ]
    for i, elem in enumerate(elements, 1):
        cp = elem["clickablePoint"]
        br = elem["boundingRect"]
        text_lines.append(
            f"  [{i}] {elem['controlType']}: \"{elem['name']}\" "
            f"@ 点击坐标({cp['x']}, {cp['y']}) "
            f"区域({br['x']},{br['y']} {br['width']}×{br['height']})"
            + (f" 值=\"{elem.get('value', '')}\"" if elem.get("value") else "")
            + (" [已禁用]" if not elem.get("isEnabled", True) else "")
        )

    return {
        "status": "success",
        "result": {
            "content": [
                {"type": "text", "text": "\n".join(text_lines)}
            ],
            "windowTitle": actual_title,
            "elementCount": len(elements),
            "elements": elements,
        }
    }


# ============================================================
# ClickText 指令
# ============================================================

def cmd_click_text(args):
    """
    执行 ClickText 指令:
    截图 → OCR → 找到匹配文本 → 自动点击其中心坐标
    """
    import pyautogui
    a = normalize_args(args)

    target_text = a.get("text") or a.get("target") or a.get("label")
    if not target_text:
        return {"status": "error", "error": "必须提供 text 参数指定要点击的文本内容。"}

    hwnd = a.get("hwnd")
    window_title = a.get("windowtitle") or a.get("window_title") or a.get("title")
    button = str(a.get("button", "left")).lower()
    clicks = int(a.get("clicks", 1))
    match_mode = str(a.get("matchmode") or a.get("match_mode") or a.get("match") or "fuzzy").lower()
    index = int(a.get("index") or a.get("nth") or 1)  # 第几个匹配（从1开始）

    # 1. 截图
    img = None
    window_rect = None
    captured_title = None

    if hwnd:
        hwnd = int(hwnd)
        import win32gui
        captured_title = win32gui.GetWindowText(hwnd) or f"HWND:{hwnd}"
        left, top, right, bottom = win32gui.GetWindowRect(hwnd)
        window_rect = {"x": left, "y": top, "width": right - left, "height": bottom - top}
        img = capture_window_by_hwnd(hwnd)
    elif window_title:
        found_hwnd, found_title = find_window_by_title(window_title)
        if found_hwnd is None:
            return {"status": "error", "error": f"未找到标题包含 '{window_title}' 的窗口。"}
        captured_title = found_title
        import win32gui
        left, top, right, bottom = win32gui.GetWindowRect(found_hwnd)
        window_rect = {"x": left, "y": top, "width": right - left, "height": bottom - top}
        hwnd = found_hwnd
        img = capture_window_by_hwnd(found_hwnd)
    else:
        img = capture_fullscreen()
        captured_title = "全屏"

    # 2. OCR
    try:
        ocr_blocks = run_ocr(img, window_rect)
    except Exception as e:
        return {"status": "error", "error": f"OCR 检测失败: {e}"}

    if not ocr_blocks:
        return {"status": "error", "error": "截图中未检测到任何文本。"}

    # 3. 查找匹配文本
    def strip_noise(s):
        """去除空格、标点和特殊符号，只留下字母数字和 CJK 文字"""
        return re.sub(r'[\s\u3000\p{P}\p{S}]' if False else r'[\s\u3000!-/:-@\[-`{-~\u2000-\u206f\u3000-\u303f\uff00-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65\u2010-\u2027\u2030-\u205e\u00a0-\u00bf]', '', s)

    matches = []
    target_lower = target_text.lower()
    target_stripped = strip_noise(target_lower)
    for blk in ocr_blocks:
        blk_text = blk["text"]
        blk_lower = blk_text.lower()
        blk_stripped = strip_noise(blk_lower)
        if match_mode == "exact":
            if blk_lower == target_lower:
                matches.append(blk)
        elif match_mode == "startswith":
            if blk_lower.startswith(target_lower):
                matches.append(blk)
        elif match_mode == "contains":
            if target_lower in blk_lower:
                matches.append(blk)
        else:  # fuzzy (默认) — 去掉空格和标点后做 contains 匹配
            if target_stripped and target_stripped in blk_stripped:
                matches.append(blk)

    if not matches:
        # 返回所有检测到的文本帮助用户调试
        all_texts = [f'"{b["text"]}"' for b in ocr_blocks[:20]]
        return {
            "status": "error",
            "error": f"未找到包含 '{target_text}' 的文本。\n检测到的文本: {', '.join(all_texts)}"
        }

    # 选择第 index 个匹配
    if index > len(matches):
        return {
            "status": "error",
            "error": f"找到 {len(matches)} 个匹配 '{target_text}' 的文本，但请求的是第 {index} 个。"
        }
    selected = matches[index - 1]
    click_x = selected["clickablePoint"]["x"]
    click_y = selected["clickablePoint"]["y"]

    # 4. 如果有 hwnd 先置前窗口
    if hwnd:
        try:
            import win32gui
            import win32con
            if win32gui.IsIconic(int(hwnd)):
                win32gui.ShowWindow(int(hwnd), win32con.SW_RESTORE)
            win32gui.SetForegroundWindow(int(hwnd))
            time.sleep(0.3)
        except Exception as e:
            debug_log(f"SetForegroundWindow failed: {e}")

    # 5. 安全检查
    screen_w, screen_h = pyautogui.size()
    if click_x < 0 or click_x >= screen_w or click_y < 0 or click_y >= screen_h:
        return {
            "status": "error",
            "error": f"文本 '{selected['text']}' 的坐标 ({click_x}, {click_y}) 超出屏幕范围。"
        }

    # 6. 执行点击
    pyautogui.click(click_x, click_y, button=button, clicks=clicks)

    result_text = (
        f"已点击文本 \"{selected['text']}\"\n"
        f"屏幕坐标: ({click_x}, {click_y})\n"
        f"匹配模式: {match_mode}，第 {index}/{len(matches)} 个匹配\n"
        f"来源: {captured_title}"
    )

    return {
        "status": "success",
        "result": {
            "content": [{"type": "text", "text": result_text}],
            "clickedText": selected["text"],
            "clickedPoint": {"x": click_x, "y": click_y},
            "totalMatches": len(matches),
            "allOcrTexts": [b["text"] for b in ocr_blocks],
        }
    }


# ============================================================
# 指令分发与串行调用
# ============================================================

COMMAND_MAP = {
    "screencapture": cmd_screen_capture,
    "capture": cmd_screen_capture,
    "screenshot": cmd_screen_capture,
    "clickat": cmd_click_at,
    "click": cmd_click_at,
    "inspectui": cmd_inspect_ui,
    "inspect": cmd_inspect_ui,
    "uiinspect": cmd_inspect_ui,
    "clicktext": cmd_click_text,
    "textclick": cmd_click_text,
}


def dispatch_command(command, params):
    """根据 command 名调度到对应函数"""
    cmd_key = command.lower().replace("_", "").replace("-", "")
    handler = COMMAND_MAP.get(cmd_key)
    if handler is None:
        return {"status": "error", "error": f"未知指令: '{command}'。可用指令: ScreenCapture, ClickAt, ClickText, InspectUI"}
    return handler(params)


def process_request(request):
    """处理请求，支持单个和串行批量调用"""

    # 检测串行调用模式: command1, command2, ...
    serial_keys = sorted([k for k in request.keys() if re.match(r'^command\d+$', k)],
                         key=lambda k: int(re.search(r'\d+', k).group()))

    if serial_keys:
        # 串行批量模式
        results = []
        for cmd_key in serial_keys:
            idx = re.search(r'\d+', cmd_key).group()
            command = request[cmd_key]

            # 提取该命令对应的参数（带相同数字后缀的 key）
            params = {}
            suffix = idx
            for k, v in request.items():
                if k == cmd_key:
                    continue
                if k.endswith(suffix) and k != cmd_key:
                    # 去掉数字后缀得到参数名
                    param_name = k[:-len(suffix)]
                    params[param_name] = v

            result = dispatch_command(command, params)
            results.append({
                "commandIndex": int(idx),
                "command": command,
                "result": result
            })

        # 汇总串行结果
        all_success = all(r["result"].get("status") == "success" for r in results)
        summary_parts = []
        for r in results:
            s = r["result"].get("status", "unknown")
            summary_parts.append(f"指令{r['commandIndex']}({r['command']}): {s}")

        return {
            "status": "success" if all_success else "partial",
            "result": {
                "content": [
                    {"type": "text", "text": "串行执行结果:\n" + "\n".join(summary_parts)}
                ],
                "serialResults": results,
                "totalCommands": len(results),
                "successCount": sum(1 for r in results if r["result"].get("status") == "success"),
            }
        }

    # 单指令模式
    command = request.get("command")
    if not command:
        return {"status": "error", "error": "缺少 command 参数。可用指令: ScreenCapture, ClickAt, InspectUI"}

    # 移除 command 键，剩余的都作为参数
    params = {k: v for k, v in request.items() if k != "command"}
    return dispatch_command(command, params)


# ============================================================
# 主入口
# ============================================================

def main():
    try:
        # 从 stdin 读取 JSON 输入
        raw_input = sys.stdin.readline().strip()
        if not raw_input:
            output_result("error", error="没有收到任何输入。请通过 stdin 发送 JSON 参数。")
            sys.exit(1)

        request = json.loads(raw_input)
        debug_log(f"收到请求: {json.dumps(request, ensure_ascii=False)[:200]}")

        result = process_request(request)

        output_result(result.get("status", "success"),
                      result=result.get("result"),
                      error=result.get("error"))

    except json.JSONDecodeError as e:
        output_result("error", error=f"JSON 解析失败: {e}")
        sys.exit(1)
    except Exception as e:
        debug_log(f"未捕获异常: {traceback.format_exc()}")
        output_result("error", error=f"插件执行异常: {str(e)}")
        sys.exit(1)


if __name__ == "__main__":
    main()
