import { readFileSync } from "node:fs"
import { join } from "node:path"
import { log, type ActorObs, type Observation, type Vec2 } from "./mechfight.ts"

type Bounds = { minX: number; minY: number; maxX: number; maxY: number }
type Footprint = { kind: string; ring: number[]; holes: number[][] }
type ArenaMap = { bounds: Bounds; prisms: Footprint[] }
type Threat = { position: Vec2; lastSeen: number }

const CELL_SIZE = 8
const WALL_CLEARANCE = 4
const SEARCH_STEPS = 13
const REPLAN_SECONDS = 1
const THREAT_MEMORY_SECONDS = 3
const UNREACHABLE = 65535
const CARDINAL_STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const

function ringContains(ring: number[], x: number, y: number, clearance: number) {
  let inside = false
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const ax = ring[j], ay = ring[j + 1]
    const bx = ring[i], by = ring[i + 1]
    const dx = bx - ax, dy = by - ay
    const lengthSquared = dx * dx + dy * dy
    if (clearance > 0 && lengthSquared > 0) {
      const fraction = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared))
      if (Math.hypot(x - (ax + fraction * dx), y - (ay + fraction * dy)) < clearance) {
        return true
      }
    }
    if ((ay > y) !== (by > y) && x < ax + (y - ay) * dx / dy) inside = !inside
  }
  return inside
}

class NavigationGrid {
  private readonly bounds: Bounds
  private readonly width: number
  private readonly height: number
  private readonly blocked: Uint8Array
  private readonly solid: Uint8Array
  private readonly adjacent: number[][]
  private zoneField?: { center: Vec2; radius: number; distances: Uint16Array }

  constructor(bounds: Bounds, footprints: Footprint[]) {
    this.bounds = bounds
    this.width = Math.ceil((bounds.maxX - bounds.minX) / CELL_SIZE)
    this.height = Math.ceil((bounds.maxY - bounds.minY) / CELL_SIZE)
    this.blocked = new Uint8Array(this.width * this.height)
    this.solid = new Uint8Array(this.blocked.length)

    for (const { kind, ring, holes } of footprints) {
      if (kind !== "building" && kind !== "stadium") continue
      const xs = ring.filter((_, index) => index % 2 === 0)
      const ys = ring.filter((_, index) => index % 2 === 1)
      const left = Math.max(0, this.column(Math.min(...xs) - WALL_CLEARANCE))
      const right = Math.min(this.width - 1, this.column(Math.max(...xs) + WALL_CLEARANCE))
      const bottom = Math.max(0, this.row(Math.min(...ys) - WALL_CLEARANCE))
      const top = Math.min(this.height - 1, this.row(Math.max(...ys) + WALL_CLEARANCE))
      for (let row = bottom; row <= top; row++) {
        for (let column = left; column <= right; column++) {
          const cell = row * this.width + column
          const [x, y] = this.center(cell)
          if (!ringContains(ring, x, y, WALL_CLEARANCE)) continue
          if (!holes.some(hole => ringContains(hole, x, y, 0))) {
            this.blocked[cell] = 1
            this.solid[cell] ||= Number(ringContains(ring, x, y, 0))
          }
        }
      }
    }
    this.adjacent = Array.from({ length: this.blocked.length }, (_, cell) => this.walkableNeighbors(cell))
  }

  private column(x: number) { return Math.floor((x - this.bounds.minX) / CELL_SIZE) }
  private row(y: number) { return Math.floor((y - this.bounds.minY) / CELL_SIZE) }

  private cell(x: number, y: number) {
    const column = this.column(x), row = this.row(y)
    return this.contains(column, row) ? row * this.width + column : -1
  }

  private contains(column: number, row: number) {
    return column >= 0 && column < this.width && row >= 0 && row < this.height
  }

  private center(cell: number): Vec2 {
    const x = this.bounds.minX + (cell % this.width + 0.5) * CELL_SIZE
    const y = this.bounds.minY + (Math.floor(cell / this.width) + 0.5) * CELL_SIZE
    return [Math.min(x, this.bounds.maxX - 0.1), Math.min(y, this.bounds.maxY - 0.1)]
  }

  private nearWall(cell: number) {
    const column = cell % this.width, row = Math.floor(cell / this.width)
    return CARDINAL_STEPS.some(([dx, dy]) => {
      const x = column + dx, y = row + dy
      return this.contains(x, y) && this.blocked[y * this.width + x] === 1
    })
  }

  private wallBetween(from: Vec2, to: Vec2) {
    const dx = to[0] - from[0], dy = to[1] - from[1]
    const samples = Math.ceil(Math.hypot(dx, dy) / (CELL_SIZE / 2))
    for (let index = 1; index < samples; index++) {
      const cell = this.cell(from[0] + dx * index / samples, from[1] + dy * index / samples)
      if (this.solid[cell]) return true
    }
    return false
  }

  private walkableNeighbors(cell: number) {
    const column = cell % this.width, row = Math.floor(cell / this.width)
    const neighbors: number[] = []
    for (const [dx, dy] of CARDINAL_STEPS) {
      if (!this.contains(column + dx, row + dy)) continue
      const neighbor = cell + dx + dy * this.width
      if (!this.blocked[neighbor]) neighbors.push(neighbor)
    }
    return neighbors
  }

  private zoneDistances(center: Vec2, radius: number) {
    const cached = this.zoneField
    if (cached && cached.center[0] === center[0] && cached.center[1] === center[1] && cached.radius === radius) {
      return cached.distances
    }
    const distances = new Uint16Array(this.blocked.length).fill(UNREACHABLE)
    const frontier: number[] = []
    let nearest = -1
    let nearestDistance = Infinity
    for (let cell = 0; cell < distances.length; cell++) {
      if (this.blocked[cell]) continue
      const [x, y] = this.center(cell)
      const distance = Math.hypot(x - center[0], y - center[1])
      if (distance < nearestDistance) {
        nearest = cell
        nearestDistance = distance
      }
      if (distance <= radius) {
        distances[cell] = 0
        frontier.push(cell)
      }
    }
    if (!frontier.length && nearest >= 0) {
      distances[nearest] = 0
      frontier.push(nearest)
    }
    // Spread outward from safe cells so progress accounts for detours around walls.
    for (let index = 0; index < frontier.length; index++) {
      const cell = frontier[index]
      for (const neighbor of this.adjacent[cell]) {
        if (distances[neighbor] !== UNREACHABLE) continue
        distances[neighbor] = distances[cell] + 1
        frontier.push(neighbor)
      }
    }
    this.zoneField = { center, radius, distances }
    return distances
  }

  route(obs: Observation, threat?: Threat): Vec2[] | undefined {
    const [x, y] = obs.self.pos
    const start = this.cell(x, y)
    if (start < 0 || this.solid[start]) return undefined

    const { center, radius, next_center: nextCenter, next_radius: nextRadius } = obs.zone
    const targetRadius = nextRadius - Math.min(35, nextRadius * 0.3)
    const zoneDistances = this.zoneDistances(nextCenter, targetRadius)
    const steps = new Map<number, number>([[start, 0]])
    const previous = new Map<number, number>()
    const frontier = [start]
    let bestCell = start
    let bestCost = Infinity

    for (let index = 0; index < frontier.length; index++) {
      const cell = frontier[index]
      const depth = steps.get(cell)!
      const point: Vec2 = cell === start ? [x, y] : this.center(cell)
      const outside = Math.max(0, Math.hypot(point[0] - center[0], point[1] - center[1]) - radius)
      const directDistance = Math.max(0, Math.hypot(point[0] - nextCenter[0], point[1] - nextCenter[1]) - targetRadius)
      let gridDistance = zoneDistances[cell]
      if (cell === start && this.blocked[start]) {
        for (const neighbor of this.adjacent[start]) {
          gridDistance = Math.min(gridDistance, zoneDistances[neighbor] + 1)
        }
      }
      const routeDistance = gridDistance === UNREACHABLE ? 0 : gridDistance * CELL_SIZE
      const hidden = threat && this.wallBetween(point, threat.position)
      const cover = hidden ? 56 : this.nearWall(cell) ? 28 : 0
      const cost = depth * CELL_SIZE + 6 * outside + 3 * Math.max(directDistance, routeDistance) - cover
      if (cost < bestCost) {
        bestCost = cost
        bestCell = cell
      }
      if (depth >= SEARCH_STEPS) continue
      for (const neighbor of this.adjacent[cell]) {
        if (steps.has(neighbor)) continue
        steps.set(neighbor, depth + 1)
        previous.set(neighbor, cell)
        frontier.push(neighbor)
      }
    }

    const path: Vec2[] = []
    for (let cell = bestCell; cell !== start; cell = previous.get(cell)!) path.push(this.center(cell))
    return path.reverse()
  }
}

export function createNavigator(mapDirectory: string) {
  let grid: NavigationGrid
  try {
    const map: ArenaMap = JSON.parse(readFileSync(join(mapDirectory, "v2", "world.json"), "utf8"))
    grid = new NavigationGrid(map.bounds, map.prisms)
  } catch (error) {
    log(`Map unavailable; using zone movement: ${String(error)}`)
    return () => undefined
  }

  let path: Vec2[] | undefined
  let threat: Threat | undefined
  let replanAt = -Infinity
  let lastZoneRadius = -1

  return (obs: Observation, enemy?: ActorObs): Vec2 | undefined => {
    if (enemy) threat = { position: [enemy.pos[0], enemy.pos[1]], lastSeen: obs.t }
    if (threat && obs.t - threat.lastSeen > THREAT_MEMORY_SECONDS) threat = undefined
    if (obs.t >= replanAt || obs.zone.next_radius !== lastZoneRadius) {
      path = grid.route(obs, threat)
      replanAt = obs.t + REPLAN_SECONDS
      lastZoneRadius = obs.zone.next_radius
    }
    if (!path) return undefined

    const [x, y] = obs.self.pos
    while (path.length && Math.hypot(path[0][0] - x, path[0][1] - y) < 2.5) path.shift()
    if (!path.length && obs.zone.next_radius < CELL_SIZE) return undefined
    return path[0] ?? [x, y]
  }
}
