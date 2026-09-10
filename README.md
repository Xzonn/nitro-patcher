# nitro-patcher

使用 TypeScript 编写的原生 Node.js NDS ROM 补丁工具，迁移自 [NitroPatcher](https://github.com/Xzonn/NitroPatcher) 和 [NitroHelper](https://github.com/Xzonn/NitroHelper)。

运行环境：Node.js 22 或更高版本。

## 安装与 CLI

```sh
pnpm add nitro-patcher
npx nitro-patcher original.nds patch.zip patched.nds
```

也可以直接运行：

```sh
npx nitro-patcher --json original.nds patch.zip patched.nds
```

## License

GPL v3，见 [LICENSE](LICENSE)。
