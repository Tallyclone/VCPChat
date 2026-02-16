#!/bin/bash

# =================================================================
# VCPToolBox 交互式 Git 更新脚本 (优化版)
# 作者: Nova
# 环境: Git Bash / WSL
# =================================================================

# --- 配置变量 ---
UPSTREAM_URL="https://github.com/lioensky/VCPToolBox.git"
BRANCH="main"
UPSTREAM_REMOTE="upstream"
# 扩展配置文件模式，涵盖更多常见格式
CONFIG_PATTERNS='\.txt$|\.md$|\.env$|\.json$|\.example$|\.yml$|\.yaml$|\.ini$|\.xml$'
OVERWRITE_COUNT=0
SKIP_COUNT=0
STASH_NEEDED=false # 标记是否进行了 stash 操作

# --- 辅助函数 ---

# 函数：询问用户是否覆盖文件
ask_for_overwrite() {
    local file=$1
    echo -e "\n========================================================"
    echo -e ">>> 文件差异: $file (本地 vs 上游)"
    echo -e "========================================================"
    
    # 实时显示差异
    # 注意：此时的差异是工作区/暂存区与HEAD的差异，因为rebase已完成
    # 且stash pop已尝试恢复本地修改。
    # 如果文件在本地被修改，git diff会显示这些修改。
    git diff -- "$file"
    
    echo -e "\n[决策点] 文件: $file"
    echo "  - 输入 'y' 或 'Y': 使用上游版本覆盖本地修改。"
    echo "  - 输入 'n' 或 'N': 保留本地版本，跳过覆盖。"
    echo "  - 输入 'q' 或 'Q': 退出脚本。"
    
    read -p "是否覆盖此文件 [Y/n/q]? " choice
    
    case "$choice" in
        [Yy]* )
            echo ">> [执行覆盖] 正在使用上游版本覆盖: $file"
            # 这里的 git checkout $UPSTREAM_REMOTE/$BRANCH -- "$file" 将文件重置为上游版本
            # 但由于 rebase 已经完成，上游版本实际上已经合并到了本地 HEAD。
            # 更准确的做法是直接重置该文件到 HEAD 对应的上游内容，或者在 stash pop 之前就决定。
            # 考虑到 rebase 后的文件状态，我们直接 checkout 上游的版本
            # 这里的逻辑是：如果用户选择覆盖，那么就用远程上游分支的对应文件覆盖本地文件
            git checkout $UPSTREAM_REMOTE/$BRANCH -- "$file"
            git add "$file" # 将覆盖后的文件加入暂存区
            OVERWRITE_COUNT=$((OVERWRITE_COUNT + 1))
            ;;
        [Nn]* )
            echo ">> [保留本地] 跳过文件: $file"
            SKIP_COUNT=$((SKIP_COUNT + 1))
            ;;
        [Qq]* )
            echo ">> [退出] 脚本终止，请检查工作区状态。"
            exit 0
            ;;
        * )
            echo "无效输入，默认为保留本地版本。"
            SKIP_COUNT=$((SKIP_COUNT + 1))
            ;;
    esac
}

# --- 主程序开始 ---

echo "--- 1. 准备环境和拉取上游数据 ---"
# 确保在正确的分支上
git checkout $BRANCH

# 添加上游远程仓库（如果不存在）
if ! git remote get-url $UPSTREAM_REMOTE > /dev/null 2>&1; then
    echo ">> 正在添加远程上游仓库: $UPSTREAM_REMOTE"
    git remote add $UPSTREAM_REMOTE $UPSTREAM_URL
fi

# 获取上游最新数据
echo ">> 正在获取上游 ($UPSTREAM_REMOTE) 最新数据..."
git fetch $UPSTREAM_REMOTE

echo -e "\n--- 2. 上游更新概览 (Commit Log) ---"
echo "以下是 $UPSTREAM_REMOTE/$BRANCH 比您的 $BRANCH 分支多出的提交："
git log --oneline $BRANCH..$UPSTREAM_REMOTE/$BRANCH
echo "-------------------------------------"

# =================================================================
# 3. 暂存所有本地未提交的修改 (包括未跟踪文件)
#    这是为了确保 rebase 可以在一个干净的工作区进行，避免不必要的冲突。
# =================================================================
echo -e "\n--- 3. 暂存本地所有修改以准备 Rebase ---"
if git stash push --include-untracked -m "Pre-rebase local changes for VCPToolBox update" > /dev/null 2>&1; then
    STASH_NEEDED=true
    echo ">> 已暂存本地修改和未跟踪文件。稍后将尝试恢复。"
else
    echo ">> 未发现本地修改或未跟踪文件需要暂存。"
fi

# =================================================================
# 4. 代码文件合并 (Rebase)
# =================================================================
echo -e "\n--- 4. 执行 Rebase 合并 ---"
echo "正在将本地分支 '$BRANCH' rebase 到上游分支 '$UPSTREAM_REMOTE/$BRANCH'..."

git rebase $UPSTREAM_REMOTE/$BRANCH

if [ $? -ne 0 ]; then
    echo -e "\n[FATAL ERROR] Rebase 失败或暂停！"
    echo "请手动解决冲突（编辑文件，执行 'git add .'），然后执行 'git rebase --continue' 或 'git rebase --abort'。"
    if $STASH_NEEDED; then
        echo "提示：由于之前有暂存操作，如果 rebase 失败并选择 abort，可能需要手动执行 'git stash pop' 来恢复之前的本地修改。"
    fi
    exit 1
fi
echo "[SUCCESS] Rebase 完成，您的代码已与上游同步。"

# =================================================================
# 5. 恢复本地修改并交互式精细化决策 (配置文件/文档)
# =================================================================
echo -e "\n--- 5. 恢复本地修改并处理配置文件/文档 ---"
if $STASH_NEEDED; then
    echo ">> 正在恢复之前暂存的本地修改..."
    git stash pop
    if [ $? -ne 0 ]; then
        echo -e "\n[WARNING] 恢复暂存失败或产生冲突！"
        echo "这意味着您之前暂存的本地修改与上游更新有冲突。请手动解决这些冲突。"
        echo "  - 解决冲突后，执行 'git add .' 和 'git stash drop' (如果需要) 清理暂存。"
        echo "脚本将尝试继续，但请务必检查工作区状态。"
        # 此时，冲突文件会显示在工作区，git diff 会显示其差异
    else
        echo ">> 本地修改已成功恢复。"
    fi
fi

# 重新获取所有有差异的文件，现在包括了 rebase 后和 stash pop 后可能产生的差异
# 此时的差异是工作区/暂存区与HEAD的差异
ALL_POST_REBASE_DIFF_FILES=$(git diff --name-only)
CONFIG_FILES_POST_REBASE=$(echo "$ALL_POST_REBASE_DIFF_FILES" | grep -E $CONFIG_PATTERNS)

if [ -z "$CONFIG_FILES_POST_REBASE" ]; then
    echo "[INFO] 未发现需要精细化处理的配置或文档文件更新（或已在 rebase 期间自动合并）。"
else
    echo "发现以下配置/文档文件在恢复本地修改后存在差异，将逐个询问是否覆盖："
    echo "$CONFIG_FILES_POST_REBASE"
    
    for file in $CONFIG_FILES_POST_REBASE; do
        ask_for_overwrite "$file"
    done
    
    echo -e "\n--- 决策总结 ---"
    echo "已覆盖文件数量: $OVERWRITE_COUNT"
    echo "已保留文件数量: $SKIP_COUNT"
fi

# =================================================================
# 6. 推送到您的远程仓库
# =================================================================
echo -e "\n--- 6. 推送到您的远程仓库 (origin) ---"

# 检查 origin 远程仓库是否存在
if ! git remote get-url origin > /dev/null 2>&1; then
    echo "[ERROR] 未检测到名为 'origin' 的远程仓库。"
    echo "请确保您的 fork 已正确配置远程仓库，例如执行："
    echo "  git remote add origin YOUR_FORK_URL"
    echo "脚本终止，请手动处理。"
    exit 1
fi

read -p "是否推送到您的远程仓库 (origin/$BRANCH) [Y/n]? " push_choice
push_choice=${push_choice:-Y} # 默认选择Y

case "$push_choice" in
    [Yy]* )
        echo ">> 正在推送 '$BRANCH' 到 'origin/$BRANCH'..."
        # 使用 --force-with-lease 是 rebase 后的推荐安全做法
        git push origin $BRANCH --force-with-lease 
        if [ $? -eq 0 ]; then
            echo "[SUCCESS] 推送完成！您的 Fork 已更新。"
        else
            echo "[ERROR] 推送失败，请检查网络、权限或手动解决冲突后再次尝试。"
        fi
        ;;
    * )
        echo ">> 已跳过推送。您可以在稍后手动执行：git push origin $BRANCH --force-with-lease"
        ;;
esac

echo -e "\n--- 脚本执行完毕 ---"
echo "请检查您的工作区状态：git status"