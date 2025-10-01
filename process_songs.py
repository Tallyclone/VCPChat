import json
import os
import re

def sanitize_filename(name):
    """
    移除文件名中的非法字符。
    """
    return re.sub(r'[\\/*?:"<>|]', "", name)

# 定义输出目录
output_dir = '音乐列表'

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
        title = song.get('title', '未知曲名')
        artist = song.get('artist', '未知歌手')
        album = song.get('album', '未知专辑')

        # 创建文件名
        filename = f"{sanitize_filename(title)}-{sanitize_filename(artist)}-{sanitize_filename(album)}.txt"
        
        # 创建文件内容
        content = f"歌曲名：{title}\n歌手：{artist}\n专辑名：{album}"
        
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
