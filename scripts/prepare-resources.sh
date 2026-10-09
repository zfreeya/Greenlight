#!/usr/bin/env bash
# 重建 .app 打包所需的内嵌资源（体积巨大，不进 git）
# 来源：本机常驻记忆服务（~/.harness-memory/services）与系统 Node 运行时
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 复制 node 运行时 =="
mkdir -p src-tauri/resources/node/bin src-tauri/resources/node/lib
REAL_NODE="$(python3 -c 'import os;print(os.path.realpath("/opt/homebrew/bin/node"))')"
cp "$REAL_NODE" src-tauri/resources/node/bin/node
chmod 755 src-tauri/resources/node/bin/node
NODE_LIBDIR="$(dirname "$(dirname "$REAL_NODE")")/lib"
cp "$NODE_LIBDIR"/libnode.*.dylib src-tauri/resources/node/lib/ 2>/dev/null || true

echo "== 复制记忆服务 =="
mkdir -p src-tauri/resources/memory-core src-tauri/resources/memory-proxy
rm -rf src-tauri/resources/memory-core/* src-tauri/resources/memory-proxy/*
cp -R "$HOME/.harness-memory/services/MemoryCore/." src-tauri/resources/memory-core/
cp -R "$HOME/.harness-memory/services/MemoryProxy/." src-tauri/resources/memory-proxy/

echo "== 复制工具服务（全量，含 director 生成引擎与 seedance sidecar） =="
mkdir -p src-tauri/resources/tools-server
rm -rf src-tauri/resources/tools-server/*
cp tools-server/index.mjs tools-server/godot-server.mjs tools-server/director-server.mjs src-tauri/resources/tools-server/
cp -R tools-server/director src-tauri/resources/tools-server/director
find src-tauri/resources/tools-server -name "*.test.mjs" -delete
# seedance 能力矩阵与校验不需要 SDK 之外的运行时；worker 启动脚本保留
chmod 755 src-tauri/resources/tools-server/director/seedance/worker.py 2>/dev/null || true

echo "== 内嵌 Seedance Python SDK 依赖（site-packages，供打包版 worker 使用） =="
rm -rf src-tauri/resources/python-site-packages
mkdir -p src-tauri/resources/python-site-packages
if [ -d .venv/lib/python3.12/site-packages ]; then
  SITE=.venv/lib/python3.12/site-packages
  DST=src-tauri/resources/python-site-packages
  # 全量复制后剔除：开发工具 + 未使用的火山服务包（只保留 arkruntime/core/ark）
  cp -R "$SITE/." "$DST/"
  find "$DST" -maxdepth 1 -type d \( -name "pip*" -o -name "setuptools*" -o -name "pkg_resources*" -o -name "pytest*" -o -name "_pytest*" -o -name "wheel*" -o -name "tests" -o -name "test" \) -exec rm -rf {} +
  find "$DST" -maxdepth 1 -type d -name "volcenginesdk*" ! -name "volcenginesdkarkruntime" ! -name "volcenginesdkark" ! -name "volcenginesdkcore" -exec rm -rf {} +
  find "$DST" -maxdepth 1 -type d -name "volcengine-*" ! -name "volcengine-python-sdk*" -exec rm -rf {} +
  find "$DST" -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
  find "$DST" -name "*.pyc" -delete 2>/dev/null || true
  du -sh "$DST"
else
  echo "警告：未找到 .venv/lib/python3.12/site-packages，打包版将无法本地调用 Seedance（需要目标机安装 SDK）"
fi

echo "== 清理失效符号链接（cargo-bundle 依赖） =="
find src-tauri/resources -type l ! -exec test -e {} \; -delete 2>/dev/null || true

echo "== 完成 =="
du -sh src-tauri/resources/