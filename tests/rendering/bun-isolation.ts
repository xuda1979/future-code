import { mock } from 'bun:test'

// Same boundary as the Node source loader; do not import the CLI's settings and
// logging dependency graph just to exercise terminal rendering.
mock.module('../../src/utils/debug.ts', () => ({ logForDebugging: () => {} }))
