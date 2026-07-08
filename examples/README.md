# examples

Sample repositories used as fixtures by the detection + feature tests
(`src/context/detection.spec.ts`, `src/modules/features.spec.ts`). Each one is a
minimal, self-contained repo that exercises one detection/runtime combination.
They double as living documentation of what `bumper detect` recognises.

| dir             | runtime | package manager | monorepo | notable files                                                |
| --------------- | ------- | --------------- | -------- | ------------------------------------------------------------ |
| `node-npm`      | node    | npm             | no       | `package-lock.json`, `.node-version`, `Dockerfile`, workflow |
| `node-pnpm`     | node    | pnpm            | no       | `pnpm-lock.yaml`, `.node-version`                            |
| `bun`           | bun     | bun             | no       | `bun.lock`, `packageManager: bun@…`                          |
| `pnpm-monorepo` | node    | pnpm            | yes      | `pnpm-workspace.yaml`, `packages/a`, `packages/b`            |

Try it against any of them:

```sh
bun run --bun src/cli.ts detect examples/node-npm
bun run --bun src/cli.ts detect examples/bun --json
```

The lockfiles are intentionally stubbed — detection only checks for their presence,
so they carry just enough shape to be recognisable, not a full dependency graph.
