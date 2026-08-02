// jest.config.ts
import type { JestConfigWithTsJest } from 'ts-jest';

const jestConfig: JestConfigWithTsJest = {
    // [...]
    preset: 'ts-jest/presets/default-esm', // or other ESM presets
    moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
        '^src/types\\.d$': '<rootDir>/test/__mocks__/types-runtime.ts',
        '^src/types$': '<rootDir>/test/__mocks__/types-runtime.ts',
        '^(\\.{1,2}/.*)/types\\.d$':
            '<rootDir>/test/__mocks__/types-runtime.ts',
        '^(\\.{1,2}/.*)/types$': '<rootDir>/test/__mocks__/types-runtime.ts',
    },
    transform: {
        // '^.+\\.[tj]sx?$' to process ts,js,tsx,jsx with `ts-jest`
        // '^.+\\.m?[tj]sx?$' to process ts,js,tsx,jsx,mts,mjs,mtsx,mjsx with `ts-jest`
        '^.+\\.tsx?$': [
            'ts-jest',
            {
                useESM: true,
            },
        ],
    },
};

export default jestConfig;
