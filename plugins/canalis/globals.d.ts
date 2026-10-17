// What the Extism runtime provides inside a plugin.
declare const Host: {
  inputString(): string;
  outputString(value: string): void;
  getFunctions(): Record<string, (offset: bigint) => bigint>;
};
declare const Memory: {
  fromString(value: string): { offset: bigint };
  find(offset: bigint): { readString(): string };
};
