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
    echo -e "\n\e[1m\e[36m========================================================\e[0m"
    echo -e "\e[1m\e[36m>>> 文件差异: $file (本地 vs 上游)\e[0m"
    echo -e "\e[1m\e[36m========================================================\e[0m"
    
    # 实时显示差异
    git diff -- "$file"
    
    echo -e "\n\e[1m\e[33m[决策点] 文件: $file\e[0m"
    echo "  - \e[32m输入 'y' 或 'Y': 使用上游版本覆盖本地修改。\e[0m"
    echo "  - \e[33m输入 'n' 或 'N': 保留本地版本，跳过覆盖。\e[0m"
    echo "  - \e[31m输入 'q' 或 'Q': 退出脚本。\e[0m"
    
    read -p "$(echo -e "\e[1m\e[33m是否覆盖此文件 [Y/n/q]? \e[0m")" choice
    
    case "$choice" in
        [Yy]* )
            echo -e "\e[32m>> [执行覆盖] 正在使用上游版本覆盖: $file\e[0m"
            git checkout $UPSTREAM_REMOTE/$BRANCH -- "$file"
            git add "$file" # 将覆盖后的文件加入暂存区
            OVERWRITE_COUNT=$((OVERWRITE_COUNT + 1))
            ;;
        [Nn]* )
            echo -e "\e[33m>> [保留本地] 跳过文件: $file\e[0m"
            SKIP_COUNT=$((SKIP_COUNT + 1))
            ;;
        [Qq]* )
            echo -e "\e[31m>> [退出] 脚本终止，请检查工作区状态。\e[0m"
            exit 0
            ;;
        * )
            echo -e "\e[33m无效输入，默认为保留本地版本。\e[0m"
            SKIP_COUNT=$((SKIP_COUNT + 1))
            ;;
    esac
}

# --- 主程序开始 ---

echo -e "\e[1m\e[36m--- 1. 准备环境和拉取上游数据 ---\e[0m"
# 确保在正确的分支上
git checkout $BRANCH

# 添加上游远程仓库（如果不存在）
if ! git remote get-url $UPSTREAM_REMOTE > /dev/null 2>&1; then
    echo -e "\e[32m>> 正在添加远程上游仓库: $UPSTREAM_REMOTE\e[0m"
    git remote add $UPSTREAM_REMOTE $UPSTREAM_URL
fi

# 获取上游最新数据
echo -e "\e[32m>> 正在获取上游 ($UPSTREAM_REMOTE) 最新数据...\e[0m"
git fetch $UPSTREAM_REMOTE

echo -e "\n\e[1m\e[36m--- 2. 上游更新概览 (Commit Log) ---\e[0m"
echo -e "\e[34m以下是 $UPSTREAM_REMOTE/$BRANCH 比您的 $BRANCH 分支多出的提交：\e[0m"
git log --oneline $BRANCH..$UPSTREAM_REMOTE/$BRANCH
echo -e "\e[1m\e[36m-------------------------------------\e[0m"

# =================================================================
# 3. 暂存所有本地未提交的修改 (包括未跟踪文件)
#    这是为了确保 rebase 可以在一个干净的工作区进行，避免不必要的冲突。
# =================================================================
echo -e "\n\e[1m\e[36m--- 3. 暂存本地所有修改以准备 Rebase ---\e[0m"
if git stash push --include-untracked -m "Pre-rebase local changes for VCPToolBox update" > /dev/null 2>&1; then
    STASH_NEEDED=true
    echo -e "\e[32m>> 已暂存本地修改和未跟踪文件。稍后将尝试恢复。\e[0m"
else
    echo -e "\e[33m>> 未发现本地修改或未跟踪文件需要暂存。\e[0m"
fi

# =================================================================
# 4. 代码文件合并 (Rebase)
# =================================================================
echo -e "\n\e[1m\e[36m--- 4. 执行 Rebase 合并 ---\e[0m"
echo -e "\e[32m正在将本地分支 '$BRANCH' rebase 到上游分支 '$UPSTREAM_REMOTE/$BRANCH'...\e[0m"

git rebase $UPSTREAM_REMOTE/$BRANCH

if [ $? -ne 0 ]; then
    echo -e "\n\e[1m\e[31m[FATAL ERROR] Rebase 失败或暂停！\e[0m"
    echo -e "\e[31m请手动解决冲突（编辑文件，执行 'git add .'），然后执行 'git rebase --continue' 或 'git rebase --abort'。\e[0m"
    if $STASH_NEEDED; then
        echo -e "\e[33m提示：由于之前有暂存操作，如果 rebase 失败并选择 abort，可能需要手动执行 'git stash pop' 来恢复之前的本地修改。\e[0m"
    fi
    exit 1
fi
echo -e "\e[32m[SUCCESS] Rebase 完成，您的代码已与上游同步。\e[0m"

# =================================================================
# 5. 恢复本地修改并交互式精细化决策 (配置文件/文档)
# =================================================================
echo -e "\n\e[1m\e[36m--- 5. 恢复本地修改并处理配置文件/文档 ---\e[0m"
if $STASH_NEEDED; then
    echo -e "\e[32m>> 正在恢复之前暂存的本地修改...\e[0m"
    git stash pop
    if [ $? -ne 0 ]; then
        echo -e "\n\e[1m\e[31m[WARNING] 恢复暂存失败或产生冲突！\e[0m"
        echo -e "\e[31m这意味着您之前暂存的本地修改与上游更新有冲突。请手动解决这些冲突。\e[0m"
        echo -e "\e[31m  - 解决冲突后，执行 'git add .' 和 'git stash drop' (如果需要) 清理暂存。\e[0m"
        echo -e "\e[31m脚本将尝试继续，但请务必检查工作区状态。\e[0m"
        # 此时，冲突文件会显示在工作区，git diff 会显示其差异
    else
        echo -e "\e[32m>> 本地修改已成功恢复。\e[0m"
    fi
fi

# 重新获取所有有差异的文件，现在包括了 rebase 后和 stash pop 后可能产生的差异
# 此时的差异是工作区/暂存区与HEAD的差异
ALL_POST_REBASE_DIFF_FILES=$(git diff --name-only)
CONFIG_FILES_POST_REBASE=$(echo "$ALL_POST_REBASE_DIFF_FILES" | grep -E $CONFIG_PATTERNS)

if [ -z "$CONFIG_FILES_POST_REBASE" ]; then
    echo -e "\e[33m[INFO] 未发现需要精细化处理的配置或文档文件更新（或已在 rebase 期间自动合并）。\e[0m"
else
    echo -e "\e[34m发现以下配置/文档文件在恢复本地修改后存在差异，将逐个询问是否覆盖：\e[0m"
    echo "$CONFIG_FILES_POST_REBASE"
    
    for file in $CONFIG_FILES_POST_REBASE; do
        ask_for_overwrite "$file"
    done
    
    echo -e "\n\e[1m\e[36m--- 决策总结 ---\e[0m"
    echo -e "\e[32m已覆盖文件数量: $OVERWRITE_COUNT\e[0m"
    echo -e "\e[33m已保留文件数量: $SKIP_COUNT\e[0m"
fi

# =================================================================
# 6. 推送到您的远程仓库
# =================================================================
echo -e "\n\e[1m\e[36m--- 6. 推送到您的远程仓库 (origin) ---\e[0m"

# 检查 origin 远程仓库是否存在
if ! git remote get-url origin > /dev/null 2>&1; then
    echo -e "\e[1m\e[31m[ERROR] 未检测到名为 'origin' 的远程仓库。\e[0m"
    echo -e "\e[31m请确保您的 fork 已正确配置远程仓库，例如执行：\e[0m"
    echo -e "\e[31m  git remote add origin YOUR_FORK_URL\e[0m"
    echo -e "\e[31m脚本终止，请手动处理。\e[0m"
    exit 1
fi

read -p "$(echo -e "\e[1m\e[33m是否推送到您的远程仓库 (origin/$BRANCH) [Y/n]? \e[0m")" push_choice
push_choice=${push_choice:-Y} # 默认选择Y

case "$push_choice" in
    [Yy]* )
        echo -e "\e[32m>> 正在推送 '$BRANCH' 到 'origin/$BRANCH'...\e[0m"
        # 使用 --force-with-lease 是 rebase 后的推荐安全做法
        git push origin $BRANCH --force-with-lease 
        if [ $? -eq 0 ]; then
            echo -e "\e[32m[SUCCESS] 推送完成！您的 Fork 已更新。\e[0m"
        else
            echo -e "\e[31m[ERROR] 推送失败，请检查网络、权限或手动解决冲突后再次尝试。\e[0m"
        fi
        ;;
    * )
        echo -e "\e[33m>> 已跳过推送。您可以在稍后手动执行：git push origin $BRANCH --force-with-lease\e[0m"
        ;;
esac

echo -e "\n\e[1m\e[36m--- 脚本执行完毕 ---\e[0m"
echo -e "\e[33m请检查您的工作区状态：git status\e[0m"