# PetDesk Dev Brief — 开发精炼版

> 供 Claude 开发时快速索引。完整产品逻辑见 `PRD-Merged.md`。
> 核心变更：渲染引擎从 Canvas 精灵图 → **透明视频 (WebM Alpha) + Canvas 叠加层**。

---

## 技术栈

```
MVP:     Electron + Vite + <video> (WebM Alpha) + Canvas 叠加层
存储:    本地 JSON 配置文件 (MVP) → SQLite (迭代)
视频:    WebM VP9 Alpha (首选) / chroma-key Canvas 合成 (兜底)
转码:    内置 FFmpeg (用户上传视频自动转 WebM Alpha)
```

## 项目结构（更新）

```
deskPet/
├── electron/              # Electron 主进程
│   ├── main.ts            # 窗口管理、托盘
│   ├── window-tracker.ts  # ★ 前台窗口坐标获取 (不变)
│   ├── input-monitor.ts   # 鼠标/键盘/剪贴板监听 (不变)
│   └── preload.ts
├── src/                   # 渲染进程
│   ├── pet/
│   │   ├── video-player.ts    # ★ <video> 元素管理, 播放/切换/预加载
│   │   ├── video-controller.ts # ★ 视频状态机 (替代 pet-animator)
│   │   ├── overlay-canvas.ts  # Canvas 叠加层 (粒子/气泡/进度条/头饰)
│   │   ├── pet-behavior.ts    # 行为决策 (空闲/被动/主动, 不变)
│   │   └── chroma-key.ts      # Canvas 抠色工具 (用户上传视频去背景)
│   ├── systems/
│   │   ├── mood.ts            # 情绪参数
│   │   ├── personality.ts     # 性格 3 参数
│   │   ├── todo.ts            # 待办 CRUD
│   │   ├── subscription.ts    # 订阅管理
│   │   ├── reminder.ts        # 休息/饮水提醒
│   │   └── warning.ts         # 摸鱼预警规则引擎
│   ├── utils/
│   │   ├── app-detector.ts    # 前台应用识别
│   │   └── weather.ts         # OpenWeather
│   └── App.tsx                # 设置面板
├── assets/                # ★ 宠物视频素材 (替代 sprites)
│   └── default-cat/
│       ├── idle.webm
│       ├── walk.webm
│       ├── happy.webm
│       ├── surprised.webm
│       ├── sleep.webm
│       ├── scared.webm
│       └── preview.png
├── docs/
└── package.json
```

---

## 渲染引擎核心

### 视频渲染层

```
┌──────────────────────────────────┐
│  Electron 无边框透明窗口          │
│                                  │
│  <video id="pet-video">          │  ← 视频层: WebM VP9 Alpha
│    src="assets/cat/idle.webm"    │     透明通道原生支持
│    loop muted                     │
│  </video>                        │
│                                  │
│  <canvas id="overlay">           │  ← Canvas 叠加层:
│    ┌─ 天气粒子 (雨/雪)           │     z-index 高于 video
│    ├─ 节日头饰 (圣诞帽/红包)      │     pointer-events: none
│    ├─ 进度条 (待办完成度)        │     (点击穿透到 video)
│    ├─ 文字气泡                   │
│    └─ 烟花/庆祝特效              │
│  </canvas>                       │
└──────────────────────────────────┘
```

### 视频状态机

```
         ┌──────────────────────────────────┐
         │            IDLE (循环)             │
         │   idle.webm + 随机 idle2.webm     │
         └────┬────┬────┬────┬────┬──────────┘
              │    │    │    │    │
    ┌─────────v─┐ ┌v────┐ ┌v───┐ ┌v───┐ ┌v──────────┐
    │  INTERACT  │ │ALERT│ │MOOD│ │EGG │ │WINDOW_SYNC │
    │ happy.webm │ │scared│ │tired│ │cele│ │ walk.webm  │
    │ (抚摸)      │ │(受惊)│ │(犯困)│ │(节日)│ │ (窗口联动) │
    └────────────┘ └─────┘ └─────┘ └─────┘ └─────┬──────┘
                                                  │
         ┌────────────────────────────────────────┘
         │  TRANSITION (crossfade 200ms)
         └──→ 回到 IDLE
```

### 视频切换流程

```
1. 事件触发 → VideoController.switchTo("happy")
2. 检查缓存 → 未预加载则先加载
3. 当前视频 opacity: 1 → 0 (200ms CSS transition)
4. 切换 src / 播放新视频
5. 新视频 opacity: 0 → 1 (200ms)
6. loop: false → 监听 ended 事件 → 自动切回 idle
   loop: true  → 持续播放直到下次事件
```

### Chroma-Key 抠色 (兜底方案，用于用户上传的无透明通道视频)

```
1. 用户上传普通 MP4 (绿幕背景)
2. 视频在隐藏的 <video> 中逐帧绘制到 Canvas
3. 每帧: getImageData → 遍历像素 → 替换指定颜色为透明
4. Canvas 直接作为宠物渲染层显示
5. 优点: 不依赖视频编码，兼容性最好
6. 缺点: CPU 开销较高 (需逐帧处理)
```

---

## 核心功能速查

### 跨窗口位置联动 ★

```
流程: 主进程每 150ms 轮询前台窗口坐标 → IPC 推送渲染进程 →
      宠物窗口实时贴边定位 + 播放 walk/climb 过渡视频

过渡序列:
  切换窗口: idle → jumpDown.webm (旧窗口跳下) → walk.webm (跑动)
           → climbUp.webm (爬上新高亮窗口) → idle (循环)
  全部用 CSS transform 移动窗口，ease-out 200ms 掩盖轮询间隔
```

### 鼠标深度互动 (7 种)

```
悬停 ≥1s     → 播放 attentive.webm (注视光标)
点击         → 播放 happy.webm + 气泡问候语 + 心情 +2
快速拖动     → 播放 scared.webm → 窗口移动到角落 (10s CD)
静置 ≥3min   → 播放 attention.webm (扒拉光标) (5min CD)
双击         → 随机播放 special1/2/3.webm (2s CD)
右键         → 上下文菜单
拖动文件     → 播放 chase.webm (追逐) (3s CD)
```

### 视频素材管理

```json
{
  "version": 1,
  "activePet": "default-cat",
  "pets": {
    "default-cat": {
      "name": "小橘",
      "preview": "assets/default-cat/preview.png",
      "actions": {
        "idle":         { "src": "idle.webm",       "loop": true  },
        "walk":         { "src": "walk.webm",       "loop": true  },
        "happy":        { "src": "happy.webm",      "loop": false },
        "surprised":    { "src": "surprised.webm",  "loop": false },
        "sleep":        { "src": "sleep.webm",      "loop": true  },
        "scared":       { "src": "scared.webm",     "loop": false },
        "celebrate":    { "src": "celebrate.webm",  "loop": false },
        "remindDrink":  { "src": "drink.webm",      "loop": false },
        "remindRest":   { "src": "rest.webm",       "loop": false },
        "warnBoss":     { "src": "warn.webm",       "loop": true  }
      }
    }
  },
  "customPets": {}
}
```

### 环境感知

```
app-rules.json: (不变)
  IDE     → 窗口侧边 + idle/"盯屏"动作
  Browser → 底部边缘 + idle
  Video   → 侧边 + "晃头"动作
  Desktop → 自由活动 wander/idle/sleep 随机
  剪贴板  → 文本长度 >200 → surprised.webm
```

### 情绪系统

```
心情值: 0-100 (每 5min 衰减 -1, 互动 +2~+10)
连续输入 2h  → remindRest.webm + "歇会儿呀"
23:00-06:00 → 播放 tired.webm (犯困), 移速 ×0.3
周五 18:00+ → celebrate.webm
30min 无互动 → 心情下降
系统唤醒     → happy.webm (迎接)
```

### 性格塑造 + 彩蛋 + 效率功能

```
性格: intimacy/energy/tsundere (不变)
天气: Canvas 雨滴/雪花粒子
节日: Canvas 头饰叠加 (圣诞帽/红包)
待办: Canvas 进度条 + celebrate.webm (100%)
摸鱼预警: warn.webm + 托盘隐藏
订阅: remindBill.webm
表情包: Canvas 截取视频帧 + 叠加文字 → 可导出 GIF
```

---

## 非功能指标（调整以适应视频）

| 指标 | MVP 目标 |
|------|----------|
| 内存 (闲置) | ≤200MB (Electron + 视频缓存) |
| CPU (闲置) | ≤8% |
| CPU (播放) | ≤15% (视频硬件解码) |
| 冷启动 | ≤4s (含首段视频预加载) |
| 视频帧率 | 30fps 稳定 |
| 平台 | Win10/11 优先, macOS 11+ 次要 |

---

## 关键决策记录

1. **视频渲染替代精灵图**：WebM VP9 Alpha 做透明视频，Canvas 降级为叠加层
2. **视频格式兜底**：用户上传的无透明通道视频用 Canvas chroma-key 抠色
3. Electron 做 MVP，PMF 确认后考虑迁移 Tauri
4. 紧急隐藏 = 系统托盘，不做 1px 圆点
5. 性格系统 MVP 仅 3 参数，不做完整行为树
6. 好友串门标记实验性，V2.0 前不投入
7. V0.5 需同时验证：(a) 透明视频在 Electron 显示 (b) 窗口坐标跟踪
