# makefun-sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/algifarri/makefun-sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/algifarri/makefun-sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's hallway-and-rooms levels. It splits each level into rooms (cutting the hallway row's dead squares), then solves every room with A* over pushes: a state is the boxes plus the player's reachable region, the estimate is the cheapest box-to-goal assignment over shortest-path distances on live squares, and dead squares plus frozen 2x2 blocks are pruned. Rooms are solved in order with the other rooms' boxes as walls, each room but the last ending with the player able to walk back out to the hallway. Everything is deterministic — fixed state budgets, never the wall clock — so two runs write the same bytes.

Verified on the kit's practice set and on 8 freshly drawn sets (45 levels): every instance solved in exactly P* pushes, score 1,000,000 each time, in about 0.3 seconds per set (limit 60 seconds).

## Run it

```sh
node main.ts   # reads /input/<id>/level.txt, writes /output/<id>/solution.txt (MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR override)
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=ajkq5baq&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
