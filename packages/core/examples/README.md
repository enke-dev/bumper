# examples

Sample repositories used as fixtures by the detection + feature tests
(`packages/core/src/context/detection.spec.ts` and the colocated module specs,
`packages/core/src/modules/**/*.spec.ts`). Each one is a
minimal, self-contained repo that exercises one detection/runtime combination.
They double as living documentation of what `bumper detect` recognises.

| dir             | runtime | package manager | monorepo | notable files                                                   |
| --------------- | ------- | --------------- | -------- | --------------------------------------------------------------- |
| `node-npm`      | node    | npm             | no       | `package-lock.json`, `.node-version`, `Dockerfile`, workflow    |
| `node-pnpm`     | node    | pnpm            | no       | `pnpm-lock.yaml`, `.node-version`                               |
| `bun`           | bun     | bun             | no       | `bun.lock`, `packageManager: bun@…`, `@types/bun`, `Dockerfile` |
| `pnpm-monorepo` | node    | pnpm            | yes      | `pnpm-workspace.yaml`, `packages/a`, `packages/b`               |

Try it against any of them:

```sh
bun run dev detect packages/core/examples/node-npm
bun run dev detect packages/core/examples/bun --json
```

The lockfiles are intentionally stubbed — detection only checks for their presence,
so they carry just enough shape to be recognisable, not a full dependency graph.
