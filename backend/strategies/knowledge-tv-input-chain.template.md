<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# TV 输入链路知识

Android TV 输入链路跟手机触控完全不同。手机是 touchscreen → InputDispatcher → App，
TV 是遥控器/键盘/CEC → InputReader → InputDispatcher → App 焦点系统 → UI 更新 → 渲染上屏。

## 输入设备类型

| 设备 | 接口 | Trace 信号 | 延迟特征 |
|------|------|-----------|---------|
| IR 遥控器 | /dev/input/event* | input_event slice | 按键→内核 5-15ms，无长按重复问题 |
| 蓝牙遥控器 | HID over BLE | input_event slice | 蓝牙重传可能导致 20-80ms 抖动 |
| USB 键盘/鼠标 | /dev/input/event* | input_event slice | 延迟最低 2-5ms |
| HDMI-CEC | CEC HAL | CEC slice（需 hal trace tag） | 设备间通信 30-100ms，CEC 消息排队更慢 |
| 语音遥控器 | Voice IME | 无直接 trace | 语音识别在云端/本地，延迟不可预测 |

## TV 输入延迟链路（DPad 按键 → 焦点移动 → 画面更新）

```
① 用户按键
   ↓
② IR/BLE 接收 → Linux input 子系统
   ↓  ftrace: evdev events (需 input ftrace tag)
③ InputReader 读取原始事件
   ↓  slice: InputReader.read (system_server)
④ InputDispatcher 派发
   ↓  slice: InputDispatcher.dispatch / sendMotion / sendKey
⑤ App ViewRootImpl.receiveEvent
   ↓  slice: deliverInputEvent / enqueueInputEvent
⑥ 焦点系统处理
   ↓  slice: ViewRootImpl.performFocusChange (Leanback/TV 常见)
⑦ Choreographer.doFrame (INPUT → ANIMATION → TRAVERSAL → COMMIT)
   ↓  slice: Choreographer#doFrame
⑧ RenderThread 渲染
   ↓  slice: DrawFrame / syncAndDrawFrame
⑨ SurfaceFlinger 合成上屏
   ↓  slice: SurfaceFlinger
⑩ Present Fence signal → 用户看到焦点变化
```

## TV vs 手机输入差异

| 维度 | 手机 | TV |
|------|------|-----|
| 输入类型 | 触摸 (MOTION) | 按键 (KEY) + DPad (MOTION) |
| 焦点模型 | 触摸即焦点 | 焦点需显式导航（focusSearch） |
| 延迟体感 | 跟手性要求高 | 焦点移动响应要求高，连续按键要跟手 |
| 常见问题 | 滑动卡顿 | 焦点跳动、长按重复、DPad 导航卡顿 |
| 关键 Slice | onTouchEvent | onFocusChange / focusSearch / requestFocus |
| 输入队列 | 通常 1 个触摸流 | KEY 事件队列 + 长按重复流 |

## TV 输入常见性能问题

1. **焦点搜索慢** — `focusSearch()` 在复杂布局（GridView/RecyclerView）中遍历深，主线程耗时长
2. **长按重复积压** — 长按 DPad 时 KEY 事件堆积，InputDispatcher 队列溢出
3. **CEC 消息排队** — 多个 HDMI-CEC 设备时消息串行处理，遥控器操作延迟叠加
4. **焦点动画超预算** — Leanback 的焦点缩放/移动动画在低性能 TV SoC 上超 16ms
5. **InputDispatcher ANR** — TV App 前台 Service 持锁导致 dispatch 超时（5s KEY / 10s MOTION）

## 相关 Trace 配置

```perfetto
data_sources {
  config {
    name: "linux.ftrace"
    ftrace_config {
      atrace_categories: "input"
      atrace_categories: "gfx"
      atrace_categories: "view"
      ftrace_events: "sched/sched_switch"
    }
  }
}
```

HDMI-CEC 需要 HAL trace tag，部分 TV 厂商需要自定义 atrace category。
