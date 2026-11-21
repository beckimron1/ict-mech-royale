# ICT Mech Royale bot

This candidate starts from the official TypeScript example. It moves into the next safe circle, holds once it reaches a buffer inside the circle, and strafes when it sees an opponent inside that buffer.

Run the official checker from the extracted `mechfight-kit` directory, with this project beside it. Node.js 22.18 or newer can run the TypeScript files directly.

```sh
python3 check/check.py -- node ../mech-royale-ict/example.ts
```

The checker replays observations to verify protocol and timing. Use the Buildathon scorer to measure match placement. The Dockerfile comes from the official starter, and it should sit at the root of the public repository used for submission.

[Official track and starter kit](https://www.joinbuilders.org/buildathon/tracks/builders)
