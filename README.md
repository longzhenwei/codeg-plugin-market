# Codeg 插件市场

Codeg 官方声明式插件的独立发布仓库。插件经过维护者审核后，通过 Ed25519 签名目录发布。只接受 `manifest.json` 和可选的 `styles.css`，不执行插件 JavaScript。

市场部署地址为 `https://longzhenwei.github.io/codeg-plugin-market/`。启用 Pages 并完成第一次发布后才可访问。初始目录为空，示例插件只出现在测试中。

## 一次性初始化

1. 将此初始化分支合入 `main` 前，维护者检查工作流和脚本。此时没有插件上架。
2. 在仓库 **Settings → Pages → Source** 中选择 **GitHub Actions**。
3. 创建名为 `github-pages` 的 Environment，Deployment branches 只允许 `main`。在该 Environment 的 Secrets 中设置 `MARKET_SIGNING_PRIVATE_KEY`，内容为 PEM 格式的专用 Ed25519 私钥。`public-key.txt` 必须与它对应。私钥由仓库所有者 `longzhenwei` 管理，不写入 Git、不上传 Pages，也不复用 Codeg 应用更新密钥。
4. 为 `main` 启用分支保护：必须通过 PR 合入、至少 1 位作者之外的维护者批准、要求 Code Owner 审核和 `Validate catalog` 检查通过、撤销过期批准、禁止强制推送及删除、管理员也不得绕过。所有者自己提交的后续 PR 需要另一位维护者审核；不要临时关闭保护来发布。
5. 在 **Actions → Publish signed market** 运行发布工作流，确认成功后访问 `index.json` 和 `index.json.sig`。同一 Pages 部署中一起发布目录、签名和资源，避免读到不同版本的文件。
6. 配置 Codeg 主机的 `CODEG_PLUGIN_MARKET_URL=https://longzhenwei.github.io/codeg-plugin-market/` 和 `CODEG_PLUGIN_MARKET_PUBLIC_KEY`（取 `public-key.txt` 内容）。桌面构建可以使用这两个构建时环境变量；远程 Codeg 连接使用服务器的配置。

## 投稿、更新和回滚

将插件放在 `plugins/<id>/<version>/`，并在 `catalog.json` 中添加或更新这一项：

```json
{
  "id": "example",
  "name": "Example",
  "description": "插件效果说明",
  "version": "1.0.0",
  "minCodegVersion": "0.32.0"
}
```

`catalog.json` 根对象为 `{"schemaVersion": 1, "plugins": [...]}`。名称、ID 和版本必须与 manifest 一致；每个 ID 只列出当前推荐的一个版本。文件哈希由构建工具计算。PR 检查覆盖清单字段、CSS 资源来源、权限、文件大小、版本号和目录不可变性；作者之外的维护者还需检查插件来源、声明的最低 Codeg 版本及实际效果。自动检查不能代替人工审核。

已合入的版本目录不允许修改、删除或追加文件。修复必须使用新的版本号。回滚通过 PR 将目录中推荐的版本改为以前审核过的版本；撤回通过 PR 删除目录条目。保留旧版本文件。客户端不会自动改变已安装插件，用户或单租户服务器管理员选择更新、回滚或卸载。

每次部署使用当前时间生成递增目录序号，有效期为 14 天；每周一重新签名并部署同一批已经审核的内容。若工作流失败，应在到期前修复并重新运行；超过有效期客户端拒绝安装，现有插件仍可使用。不要重新部署旧的 Pages artifact 进行回滚，它会触发序号回退保护。GitHub Pages 的 CDN 缓存可能短暂保留旧目录，签名不匹配时客户端会拒绝安装，可稍后重试。

公钥更换属于发布权限变更，需要单独审核、更新 Codeg 的可信公钥配置，并重新发布目录；不要静默生成一把新私钥覆盖旧密钥。所有者应在仓库之外保留加密备份，以便恢复。

## 本地检查

需要 Node.js 22 或更新版本，无需安装第三方 npm 包。

```bash
npm test
npm run check
npm run build
```

生成文件在被 Git 忽略的 `dist/`。CI 的签名步骤从 `MARKET_SIGNING_PRIVATE_KEY` 环境变量读取私钥；PR 工作流不接触私钥。Pages 只上传 `dist/`，不上传源码、Secret 或私钥。
