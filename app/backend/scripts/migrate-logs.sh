#!/usr/bin/env bash

##############################################################################
# Linglish 日志迁移脚本
# 从旧的时间戳命名方式迁移到固定文件名方式
#
# 使用方法:
#   bash scripts/migrate-logs.sh
#
# 功能:
#   1. 合并所有旧的带时间戳的日志文件
#   2. 清理旧日志文件
#   3. 准备新的日志管理方式
##############################################################################

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/../logs"

echo "=========================================="
echo "  Linglish 日志迁移工具"
echo "=========================================="
echo ""

# 检查日志目录
if [ ! -d "$LOG_DIR" ]; then
  echo "✓ 日志目录不存在，无需迁移"
  exit 0
fi

cd "$LOG_DIR"

# 统计需要迁移的文件
BACKEND_OLD_COUNT=$(ls backend-*.log 2>/dev/null | wc -l || echo "0")
FRONTEND_OLD_COUNT=$(ls frontend-*.log 2>/dev/null | wc -l || echo "0")

if [ "$BACKEND_OLD_COUNT" -eq 0 ] && [ "$FRONTEND_OLD_COUNT" -eq 0 ]; then
  echo "✓ 没有发现旧格式的日志文件，无需迁移"
  exit 0
fi

echo "发现旧格式日志文件："
echo "  - backend-*.log: $BACKEND_OLD_COUNT 个文件"
echo "  - frontend-*.log: $FRONTEND_OLD_COUNT 个文件"
echo ""

# 询问用户确认
read -p "是否继续迁移？(y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "已取消迁移"
  exit 0
fi

# 创建备份目录
BACKUP_DIR="$LOG_DIR/backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

echo ""
echo "开始迁移..."
echo ""

# 迁移 backend 日志
if [ "$BACKEND_OLD_COUNT" -gt 0 ]; then
  echo "1. 处理 backend 日志..."

  # 备份旧文件
  echo "   - 备份旧文件到 $BACKUP_DIR"
  cp backend-*.log "$BACKUP_DIR/" 2>/dev/null || true

  # 合并到归档文件
  echo "   - 合并所有旧日志到 backend.log.archive"
  cat backend-*.log > backend.log.archive 2>/dev/null || true

  # 删除旧文件
  echo "   - 删除旧格式文件"
  rm -f backend-*.log

  echo "   ✓ Backend 日志迁移完成"
fi

# 迁移 frontend 日志
if [ "$FRONTEND_OLD_COUNT" -gt 0 ]; then
  echo ""
  echo "2. 处理 frontend 日志..."

  # 备份旧文件
  echo "   - 备份旧文件到 $BACKUP_DIR"
  cp frontend-*.log "$BACKUP_DIR/" 2>/dev/null || true

  # 合并到归档文件
  echo "   - 合并所有旧日志到 frontend.log.archive"
  cat frontend-*.log > frontend.log.archive 2>/dev/null || true

  # 删除旧文件
  echo "   - 删除旧格式文件"
  rm -f frontend-*.log

  echo "   ✓ Frontend 日志迁移完成"
fi

echo ""
echo "=========================================="
echo "  迁移完成！"
echo "=========================================="
echo ""
echo "📦 结果："
echo "  - 旧文件已备份到: $BACKUP_DIR"
echo "  - Backend归档: $([ -f backend.log.archive ] && echo '✓ backend.log.archive' || echo '无')"
echo "  - Frontend归档: $([ -f frontend.log.archive ] && echo '✓ frontend.log.archive' || echo '无')"
echo ""
echo "📋 下一步："
echo "  1. 重启应用，新日志将写入固定文件名"
echo "  2. 安装 crontab 定时任务进行日志切割"
echo "     cd scripts && crontab crontab.example"
echo "  3. 查看日志管理文档: /root/linglish/LOG_MANAGEMENT.md"
echo ""
echo "⚠️  备份文件将在 30 天后自动删除"
echo "    如不需要，可手动删除: rm -rf $BACKUP_DIR"
echo ""
