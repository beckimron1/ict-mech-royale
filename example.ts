/** ICT's first Mech Royale bot, based on the official TypeScript starter. */
import { type Action, draw, type Observation, run } from "./mechfight.ts"

const dist = (a: number[], b: number[]) => Math.hypot(b[0] - a[0], b[1] - a[1])

run((hello) => ({
  name: "ICT Zone Hold",
  act(obs: Observation) {
    const me = obs.self
    const [x, y, z] = me.pos
    const goal = obs.zone.next_center
    const yaw = Math.atan2(goal[1] - y, goal[0] - x)
    // Move far enough into the next circle to leave room for a sideways dodge.
    const buffer = Math.min(35, obs.zone.next_radius * 0.3)
    const holdRadius = obs.zone.next_radius - buffer
    const needsRotation = !me.in_zone || dist(goal, me.pos) > holdRadius
    const act: Omit<Action, "tick"> = {
      move: needsRotation ? [Math.cos(yaw), Math.sin(yaw)] : [0, 0],
      aim: [yaw, 0],
      boost: !me.in_zone,
      jump: needsRotation && obs.tick % 40 === 0,
    }
    if (obs.offer) act.pick = 0
    const near = obs.pickups.find((p) => dist(p.pos, me.pos) < hello.config.loot.pickup_radius && p.kind !== "gun")
    if (!me.weapons[1] && near) act.take = near.id
    const enemy = obs.mechs.filter((m) => m.kind === "mech").sort((a, b) => dist(a.pos, me.pos) - dist(b.pos, me.pos))[0]
    if (enemy) {
      const t = enemy.pos
      act.aim = [Math.atan2(t[1] - y, t[0] - x), Math.atan2(t[2] - z - 2.5, dist(t, me.pos))]
      act.fire = [true, true]
      if (!needsRotation) {
        const direction = Math.floor(obs.tick / 30) % 2 === 0 ? 1 : -1
        const sideways = act.aim[0] + direction * Math.PI / 2
        act.move = [Math.cos(sideways), Math.sin(sideways)]
      }
      draw.line([x, y, z + 7], [t[0], t[1], t[2] + 4.5], "#ff5040")
    }
    draw.point([goal[0], goal[1], z], "#40c0ff", 6)
    draw.label(`hp ${me.hp.toFixed(0)} · ${enemy ? `target ${enemy.id}` : "searching"}`)
    return act
  },
}))
