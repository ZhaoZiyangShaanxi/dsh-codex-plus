#!/usr/bin/env node
/**
 * 测试入口。
 *
 * 不用 node --test 的目录模式：本机沙箱禁止测试运行器为每个文件 spawn 子进程
 * （EPERM）。这里在同一个进程里顺序 import 每个测试文件，node:test 会在
 * 当前进程内注册并执行它们。
 */
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const files = (await readdir(join(root, 'tests'))).filter(name => name.endsWith('.test.mjs')).sort()

for (const file of files) {
  await import('file://' + join(root, 'tests', file).replace(/\\/g, '/'))
}