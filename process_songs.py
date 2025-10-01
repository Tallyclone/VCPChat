import json
import os
import re

def sanitize_filename(name):
    """
    移除文件名中的非法字符。
    """
    return re.sub(r'[\\/*?:"<>|]', "", name)

# 定义一个包含常见乱码特征字符的集合
# '､｢ﾊｿﾈ' 是半角假名被错误解码的特征
# '乧偄傛' 是全角假名被错误解码的特征
GARBLED_CHARS = {'乧', '偄', '傛', '偹', '偠', '傞', '怣', '｢', 'ﾊ', 'ｿ', 'ﾈ'}

def fix_garbled_text(text):
    """
    尝试修复常见的编码错误导致的乱码。
    只有当文本包含特定的乱码特征字符时，才尝试修复。
    """
    # 检查文本中是否包含任何乱码特征字符
    if any(char in text for char in GARBLED_CHARS):
        try:
            # 尝试进行编码修复
            return text.encode('gbk').decode('shift-jis')
        except (UnicodeEncodeError, UnicodeDecodeError):
            # 如果修复失败，返回原始文本
            return text
    # 如果没有发现特征字符，直接返回原始文本
    return text

# 定义输出目录
output_dir = 'MusicDiary'

# 如果目录不存在，则创建它
if not os.path.exists(output_dir):
    os.makedirs(output_dir)

# JSON 文件路径
json_file_path = 'songlist.json'

try:
    # 打开并读取 JSON 文件
    with open(json_file_path, 'r', encoding='utf-8') as f:
        songs = json.load(f)

    # 遍历每首歌曲
    for song in songs:
        title = fix_garbled_text(song.get('title', '未知曲名'))
        # 移除标题末尾可能存在的 .mp3 后缀
        if title.lower().endswith('.mp3'):
            title = title[:-4]
        artist = fix_garbled_text(song.get('artist', '未知歌手'))
        album = fix_garbled_text(song.get('album', '未知专辑'))

        # 创建文件名
        filename = f"{sanitize_filename(title)}-{sanitize_filename(artist)}-{sanitize_filename(album)}.txt"
        
        # 创建文件内容
        content = f"{title}"
        
        # 写入文件
        file_path = os.path.join(output_dir, filename)
        with open(file_path, 'w', encoding='utf-8') as txt_file:
            txt_file.write(content)

    print(f"处理完成！ {len(songs)} 个文件已在 '{output_dir}' 目录中创建。")

except FileNotFoundError:
    print(f"错误: 未找到 '{json_file_path}' 文件。请确保它和脚本在同一个目录下。")
except json.JSONDecodeError:
    print(f"错误: '{json_file_path}' 文件格式不正确，无法解析。")
except Exception as e:
    print(f"发生了一个未知错误: {e}")