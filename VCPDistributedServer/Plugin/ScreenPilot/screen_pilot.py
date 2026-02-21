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
    filename = a.get("filename")

    captured_title = None
    img = None

    if hwnd:
        hwnd = int(hwnd)
        import win32gui
        captured_title = win32gui.GetWindowText(hwnd) or f"HWND:{hwnd}"
        img = capture_window_by_hwnd(hwnd)
    elif window_title:
        found_hwnd, found_title = find_window_by_title(window_title)
        if found_hwnd is None:
            return {"status": "error", "error": f"未找到标题包含 '{window_title}' 的窗口。请检查窗口是否已打开。"}
        captured_title = found_title
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

    result = {
        "content": [
            {"type": "text", "text": "\n".join(text_parts)},
            {"type": "image_url", "image_url": {"url": data_uri}}
        ],
        "resolution": {"width": width, "height": height},
    }
    if saved_path:
        result["savedPath"] = saved_path

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

    if button not in ("left", "right", "middle"):
        return {"status": "error", "error": f"无效的button参数: '{button}'，可选值: left, right, middle。"}

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
        except Exception as e:
            debug_log(f"SetForegroundWindow failed: {e}")

    # 获取屏幕尺寸用于安全检查
    screen_w, screen_h = pyautogui.size()
    if x < 0 or x >= screen_w or y < 0 or y >= screen_h:
        return {
            "status": "error",
            "error": f"坐标 ({x}, {y}) 超出屏幕范围 ({screen_w}×{screen_h})。"
        }

    # 执行点击
    pyautogui.click(x, y, button=button, clicks=clicks)

    result_text = f"已在屏幕坐标 ({x}, {y}) 执行 {button} 键点击 {clicks} 次。"
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
}


def dispatch_command(command, params):
    """根据 command 名调度到对应函数"""
    cmd_key = command.lower().replace("_", "").replace("-", "")
    handler = COMMAND_MAP.get(cmd_key)
    if handler is None:
        return {"status": "error", "error": f"未知指令: '{command}'。可用指令: ScreenCapture, ClickAt, InspectUI"}
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
