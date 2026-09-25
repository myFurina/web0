#!/usr/bin/env bash
# TechShare 停止/销毁：./stop.sh [--rm]
# 无参数：停止（数据在卷里，重建即回）
# --rm：停止并删除（下次 start.sh 会重建容器，数据仍在卷里）
# 顺序：先停/删 nginx（它共享 app 的网络，是依赖方），再停 app/reddis/mysql
set -u
cd "$(dirname "$0")"

RM=0
[[ "${1:-}" == "--rm" ]] && RM=1

stop_rm() {
  local c="$1"
  podman container exists "$c" 2>/dev/null || { echo "$c 不存在，跳过"; return; }
  if [[ $RM -eq 1 ]]; then
    podman rm -f "$c" >/dev/null 2>&1 && echo "已删 $c" || echo "删 $c 失败"
  else
    podman stop -t 5 "$c" >/dev/null 2>&1 && echo "已停 $c" || echo "$c 本来就没在跑"
  fi
}

# nginx 共享 app netns：必须先处理 nginx，再处理 app
stop_rm ts-nginx
stop_rm app
stop_rm ts-redis
stop_rm ts-mysql

[[ $RM -eq 1 ]] && echo "容器已全部删除，数据在卷里。执行 ./start.sh 可一键恢复。"
