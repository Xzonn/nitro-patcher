# Independent xdelta3 fixtures

These files were generated for this project (no ROM or third-party game data).
The encoder was compiled temporarily outside the repository from the official
[jmacd/xdelta](https://github.com/jmacd/xdelta) source at commit
`12187781877dc49d7ca0cc5653d3cd9c4b55c3ad`. Neither the application nor these tests
run this tool or require a compiler, native addon, .NET, or WebAssembly.

`source.bin` contains 2048 deterministic xorshift32 bytes, starting with seed
`0x12345678` and shifts `13, 17, 5` (low byte of each updated state).
`target.bin` concatenates:

- UTF-8 `native-vcdiff\n`
- source bytes `[41, 1700)`
- 9000 bytes `0x41`
- the complete source
- UTF-8 `abcdefgh` repeated 5000 times
- source bytes `[10, 1800)`

Generation commands, run from the project root:

```sh
xdelta3 -e -S none -W 16384 -s test/fixtures/xdelta/source.bin test/fixtures/xdelta/target.bin test/fixtures/xdelta/multiwindow.xdelta
xdelta3 -e -S none test/fixtures/xdelta/target.bin test/fixtures/xdelta/sourceless.xdelta
xdelta3 -e -S djw -s test/fixtures/xdelta/source.bin test/fixtures/xdelta/target.bin test/fixtures/xdelta/secondary-djw.xdelta
```

The first fixture exercises four target windows, source references, checksums,
and the default application header. The second uses no source. The DJW fixture
verifies explicit rejection of secondary compression, matching
[PleOps.XdeltaSharp v1.3.0 HeaderReader](https://github.com/pleonex/xdelta-sharp/blob/v1.3.0/src/PleOps.XdeltaSharp/Decoder/HeaderReader.cs),
which also rejects custom code tables. Independent handcrafted RFC 3284 vectors
in `test/xdelta.test.ts` cover target-window references and every cache mode.
