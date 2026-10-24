---
name: text-normalizer
description: 将提供的 CSV 姓名列转成大写，保留数值字段，根据用户要求排序，输出 result.csv。
---
# 文本标准化
读取用户提供的 CSV，将 name 转成大写，amount 原样保留；按用户指令决定排序。输出 result.csv。完成后读取输出，核对行数、姓名大写、amount 不变和用户要求的顺序，再回复完成情况。只使用 Python 标准库。
