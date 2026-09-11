#!/usr/bin/env python3
"""자소 군집의 표시 폭 — **제3 오라클**.

herdr 도 xterm.js 도 corral 도 아닌 곳에서 폭을 가져온다. 1차 측정의 T1 기준선이
헤드리스 xterm 의 `getCell` 이었고, 그것이 이모지를 1칸으로 세는 바람에 멀쩡한 화면이
98.92% 로 나왔다 (판정 §3). 기준선의 폭 표는 재는 대상과 독립이어야 한다.

stdin: 군집 문자열의 JSON 배열 (자르기는 Node 의 `Intl.Segmenter` 가 한다)
stdout: 폭의 JSON 배열
"""
import json
import sys

from wcwidth import wcswidth


def width(cluster: str) -> int:
    measured = wcswidth(cluster)
    # -1 은 "출력 불가"다. 화면에 칸을 안 먹는 것으로 친다 (제어문자 등).
    return max(measured, 0) if measured is not None else 0


clusters = json.load(sys.stdin)
json.dump([width(c) for c in clusters], sys.stdout)
