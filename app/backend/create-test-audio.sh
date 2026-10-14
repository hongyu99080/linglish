#!/bin/bash

# 创建测试音频文件（使用 ffmpeg 生成静音音频）
# 用于测试 ASR 功能

set -e

echo "=================================="
echo "创建测试音频文件"
echo "=================================="
echo

# 检查 ffmpeg 是否安装
if ! command -v ffmpeg &> /dev/null; then
    echo "❌ 错误: ffmpeg 未安装"
    echo "请先安装 ffmpeg:"
    echo "  Ubuntu/Debian: sudo apt-get install ffmpeg"
    echo "  CentOS/RHEL: sudo yum install ffmpeg"
    echo "  macOS: brew install ffmpeg"
    exit 1
fi

# 默认参数
DURATION=${1:-3}
OUTPUT_FILE=${2:-"test-audio-${DURATION}s.wav"}

echo "📝 参数:"
echo "   时长: ${DURATION} 秒"
echo "   输出文件: ${OUTPUT_FILE}"
echo

# 生成静音音频（16kHz, 单声道, PCM 16-bit）
echo "🎵 生成音频文件..."
ffmpeg -f lavfi -i "anullsrc=r=16000:cl=mono" -t ${DURATION} -acodec pcm_s16le "${OUTPUT_FILE}" -y 2>&1 | grep -v "^ffmpeg version" | grep -v "^configuration" | grep -v "^lib" || true

if [ -f "${OUTPUT_FILE}" ]; then
    FILE_SIZE=$(du -h "${OUTPUT_FILE}" | cut -f1)
    echo "✅ 音频文件创建成功!"
    echo "   文件路径: ${OUTPUT_FILE}"
    echo "   文件大小: ${FILE_SIZE}"
    echo

    # 显示音频信息
    echo "📊 音频信息:"
    ffprobe -v quiet -print_format json -show_format -show_streams "${OUTPUT_FILE}" | grep -E '"duration"|"sample_rate"|"channels"' || ffprobe "${OUTPUT_FILE}" 2>&1 | grep Duration
    echo

    echo "💡 使用方法:"
    echo "   1. 测试 ASR 功能:"
    echo "      node test-pronunciation-asr.js ${OUTPUT_FILE} \"I need to clean the house today\""
    echo
    echo "   2. 播放音频验证:"
    echo "      ffplay ${OUTPUT_FILE}"
    echo
else
    echo "❌ 错误: 音频文件创建失败"
    exit 1
fi
