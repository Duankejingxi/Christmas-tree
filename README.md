# 🎄 圣诞树 · 时光相册

打开网页 → 输入昵称 → （可选）放进最多 10 张照片 → 粒子从四周飞来，螺旋汇聚成一棵发光的圣诞树。

- **开启摄像头**：对着镜头捏合拇指和食指 👌，每捏一次出现一张照片，然后缩小消失（也可以点击屏幕 / 按空格）。
- **不开摄像头**：照片自动依次出现、消失。
- 所有照片展示完后，会一起挂到树上，均匀分布、随树旋转。
- 最后烟花升空，炸开的粒子汇聚成「圣诞快乐」四个大字，之后烟花持续绽放。

照片和摄像头画面只在浏览器本地处理，不会上传。

## 发布成链接（GitHub Pages）

1. 仓库 **Settings → Pages**
2. Source 选 **Deploy from a branch**，Branch 选放代码的分支，目录 `/ (root)`，保存
3. 等 1～2 分钟，访问 `https://<你的用户名>.github.io/<仓库名>/`

> 摄像头需要 HTTPS，GitHub Pages 默认就是 HTTPS。

## 本地预览

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
# 加 ?demo 可跳过表单直接看效果：http://localhost:8000/?demo
```

## 技术说明

- 渲染：Three.js（粒子着色器 + Bloom 泛光）
- 手势：MediaPipe Hand Landmarker
- 依赖全部放在仓库内（`lib/`、`assets/`），不依赖 Google / 国外 CDN，国内网络也能打开
