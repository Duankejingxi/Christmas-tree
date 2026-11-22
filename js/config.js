// 云端存储配置（用于「邀请朋友装饰」功能）
// 按 README 里的步骤创建 Supabase 项目后，把下面两个值填进去即可。
// anon key 本身就是公开的，可以放在前端代码里；数据安全由 supabase/setup.sql 里的权限规则保证。
// 留空时会进入「本机演示模式」：分享链接只在当前浏览器里有效，方便先预览效果。

export const SUPABASE_URL = 'https://uzctvqnidrltmwhqjcys.supabase.co';      // 例如 'https://abcdefghijk.supabase.co'
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV6Y3R2cW5pZHJsdG13aHFqY3lzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUzMjk5NjQsImV4cCI6MjExMDkwNTk2NH0.thvm7JogVgm0KyPZ7F6ByQtqQ7zDKwF87JfX2w37WvQ'; // Project Settings → API → anon public
