# ✨ Merry Christmas · 粒子圣诞树

一棵会发光的粒子圣诞树：两支光笔螺旋着把树「画」出来，星星点亮，照片像拍立得一样挂上树，最后烟花汇聚成「圣诞快乐」。

## 玩法

**自己的树**
1. 写下名字，放进最多 10 张照片（可选），点「点亮」
2. 树画好后可以选择：
   - **开启摄像头**：对着镜头捏合拇指和食指 👌，每捏一次出现一张照片（也可以点屏幕 / 按空格）
   - **自动播放**：照片依次出现，再飞回树上
3. 所有照片挂上树后放烟花；点树上的照片可以看大图、下载

**邀请朋友装饰**
1. 首页点「邀请朋友一起装饰」（或播放结束后点「邀请朋友」），得到一个链接和二维码
2. 朋友打开链接 → 写名字 → 选一张照片 → 「挂上去」
3. 每棵树最多 10 位朋友，后来的朋友能看到前面所有人的照片
4. 照片上会写着挂照片的人的名字；所有人都可以点开照片、单张下载或「全部下载」打包
5. 你自己再打开这个链接，就能看到朋友们挂上的所有照片

其他：右上角可以开关八音盒音乐；鼠标/手指在屏幕上划过会留下星光；拖动可以旋转圣诞树。

## 发布成网页（GitHub Pages）

Settings → Pages → Source 选 **Deploy from a branch** → 选分支、目录 `/ (root)` → Save。
1～2 分钟后访问 `https://<用户名>.github.io/<仓库名>/`。

## 开启「邀请朋友」的云端存储（Supabase，免费）

不配置也能用，只是「邀请朋友」会处于**本机演示模式**（链接只在你自己的浏览器里有效）。要让朋友真的能挂照片：

1. 注册 <https://supabase.com>，新建一个项目（Region 建议选 Singapore 或 Tokyo，国内访问更快）
2. 左侧 **SQL Editor** → New query → 把 [`supabase/setup.sql`](supabase/setup.sql) 全部粘贴进去 → Run
3. 左侧 **Project Settings → API**，复制 `Project URL` 和 `anon public` key
4. 填进 [`js/config.js`](js/config.js)：
   ```js
   export const SUPABASE_URL = 'https://xxxx.supabase.co';
   export const SUPABASE_ANON_KEY = 'eyJhbGciOi...';
   ```
5. 提交推送，等 Pages 更新即可

说明：
- anon key 本来就是给前端用的公开密钥，放在代码里没问题；权限由 `setup.sql` 限制为「只能读、只能新增，不能改、不能删」，每棵树最多 10 张照片由数据库保证
- 照片上传前会压缩到 1600px 以内，单张上限 3MB
- Supabase 免费项目一周没人访问会自动暂停，在控制台点一下恢复即可

## 本地预览

```bash
python3 -m http.server 8000
# http://localhost:8000          正常打开
# http://localhost:8000/?demo    跳过表单直接看效果
```

## 技术

Three.js（自定义粒子着色器 + Bloom）· MediaPipe Hand Landmarker（手势）· WebAudio（实时合成八音盒）· Supabase（可选）。
所有依赖都放在仓库里（`lib/`、`assets/`），不依赖国外 CDN。
