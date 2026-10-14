#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

INPUT="${1:-app/backend/.env}"
OUTPUT="${2:-app/backend/.env.annotated}"

if [[ ! -f "$INPUT" ]]; then
  echo "[annotate-env] Input file not found: $INPUT" >&2
  exit 1
fi

awk '
BEGIN {
  FS="="
  # Map: key -> comment (Chinese)
  comment["PORT"]="后端端口";
  comment["DATABASE_URL"]="数据库连接串";

  comment["OPENAI_API_KEY"]="OpenAI API Key";
  comment["OPENAI_API_BASE"]="OpenAI 代理/自定义 API 地址";
  comment["OPENAI_MODEL_GPT4"]="GPT4 模型";
  comment["OPENAI_MODEL_GPT35"]="GPT3.5 模型";
  comment["OPENAI_MAX_TOKENS"]="最大生成 tokens";
  comment["OPENAI_TEMPERATURE"]="温度";
  comment["OPENAI_TOP_P"]="Top-P";
  comment["OPENAI_FREQUENCY_PENALTY"]="频率惩罚";
  comment["OPENAI_PRESENCE_PENALTY"]="存在惩罚";
  comment["AI_MAX_RETRY_ATTEMPTS"]="AI 重试次数";
  comment["OPENAI_PROXY"]="OpenAI 代理";
  comment["OPENAI_SYSTEM_PREFIX"]="系统提示词";

  comment["DEEPL_API_KEY"]="DeepL Key（主要翻译）";
  comment["DEEPL_API_TYPE"]="DeepL 类型：free/pro";
  comment["DEEPL_TIMEOUT_MS"]="DeepL 超时（毫秒）";
  comment["GOOGLE_TRANSLATE_TIMEOUT_MS"]="Google 翻译超时（备用）";

  comment["GEMINI_API_KEY"]="Gemini Key";

  comment["REDIS_HOST"]="Redis 地址";
  comment["REDIS_PORT"]="Redis 端口";
  comment["REDIS_PASSWORD"]="Redis 密码";
  comment["REDIS_DB"]="Redis DB";
  comment["AI_CACHE_ENABLED"]="是否启用 AI 缓存";
  comment["AI_CACHE_TTL_SECONDS"]="缓存 TTL（秒）";

  comment["AI_COST_TRACKING_ENABLED"]="是否启用成本统计";
  comment["AI_DAILY_BUDGET"]="日预算";
  comment["AI_MONTHLY_BUDGET"]="月预算";
  comment["AI_COST_ALERT_THRESHOLD"]="告警阈值";

  comment["ENABLE_AI_TUTOR"]="AI 导师";
  comment["ENABLE_AI_CHAT"]="AI 聊天";
  comment["ENABLE_DAILY_PLAN"]="每日计划";
  comment["ENABLE_CONTENT_RECOMMENDATION"]="内容推荐";
  comment["ENABLE_VIDEO_TRANSCRIPTION"]="视频转录";

  comment["STT_VIDEO_PROVIDER"]="视频转录提供方";
  comment["STT_VIDEO_FALLBACK"]="视频转录备用";
  comment["STT_PRACTICE_PROVIDER"]="练习录音识别提供方";
  comment["STT_PRACTICE_FALLBACK"]="练习录音识别备用";
  comment["OPENAI_WHISPER_MODEL"]="Whisper 模型";
  comment["STT_CUSTOM_ENDPOINT"]="自建 Whisper 地址";
  comment["STT_CUSTOM_METHOD"]="自建 Whisper 请求方法";
  comment["STT_CUSTOM_LANGUAGE_PARAM"]="自建 Whisper 语言参数";
  comment["STT_CUSTOM_HEADERS_JSON"]="自建 Whisper 额外 Header（JSON）";
  comment["STT_CUSTOM_OUTPUT"]="自建 Whisper 输出格式";
  comment["STT_CUSTOM_OUTPUT_PARAM"]="自建 Whisper 输出字段";
  comment["STT_CUSTOM_DIARIZE"]="是否分离说话人";
  comment["STT_CUSTOM_DIARIZE_PARAM"]="说话人分离参数名";

  comment["BAIDU_ASR_APP_ID"]="百度 ASR App ID";
  comment["BAIDU_ASR_API_KEY"]="百度 ASR API Key";
  comment["BAIDU_ASR_SECRET_KEY"]="百度 ASR Secret";
  comment["BAIDU_ASR_CUID"]="百度 ASR CUID";
  comment["BAIDU_ASR_FORMAT"]="百度 ASR 格式";
  comment["BAIDU_ASR_SAMPLE_RATE"]="百度 ASR 采样率";
  comment["BAIDU_ASR_DEV_PID"]="百度 ASR 语种";

  comment["AUTH_DEBUG"]="认证调试日志";
  comment["AI_VOCAB_TOKEN"]="词汇 API Token";

  comment["GOOGLE_CLIENT_ID"]="Google 客户端 ID";
  comment["GOOGLE_CLIENT_SECRET"]="Google 客户端密钥";
  comment["GOOGLE_CALLBACK_URL"]="Google 回调路径";
  comment["FRONTEND_BASE_URL"]="前端域名";

  comment["FRONTEND_SHOW_ICP"]="是否显示备案号";
  comment["FRONTEND_ICP_TEXT"]="备案号文本";
  comment["FRONTEND_ENABLE_NETWORK_UPLOAD"]="是否显示网络上传入口";

  comment["ENABLE_GOOGLE_OAUTH"]="后端是否启用 Google 登录";
  comment["FRONTEND_ENABLE_GOOGLE_OAUTH"]="前端是否展示 Google 登录";

  comment["FORCE_LOCAL_VIDEO"]="强制本地播放（视为大陆用户）";
  comment["FORCE_LOCAL_VIDEO_REQUIRE_FILE"]="仅展示本地文件存在的视频";
}

/^[[:space:]]*#/ { print; next }
/^[[:space:]]*$/ { print; next }
{
  key=$1
  gsub(/[[:space:]]+/, "", key)
  if (key in comment) {
    print "# " comment[key]
  }
  print
}
' "$INPUT" > "$OUTPUT"

echo "[annotate-env] Wrote: $OUTPUT"
