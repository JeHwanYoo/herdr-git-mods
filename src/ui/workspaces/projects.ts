import { setShared, shared } from "herdr";

const KEY = "git.projects";

function parse(value: unknown): string[] {
  const projects = typeof value === "object" && value !== null && "projects" in value ? value.projects : [];
  if (!Array.isArray(projects)) return [];
  return [...new Set(projects.filter((root): root is string => typeof root === "string"))];
}

export class ProjectRegistry {
  private list: string[] = [];
  private seen = "[]";

  constructor() {
    this.changed();
  }

  roots(): readonly string[] {
    return this.list;
  }

  changed(): boolean {
    const list = parse(shared(KEY));
    const seen = JSON.stringify(list);
    if (seen === this.seen) return false;
    this.list = list;
    this.seen = seen;
    return true;
  }

  add(root: string): boolean {
    this.changed();
    if (this.list.includes(root)) return false;
    this.save([...this.list, root]);
    return true;
  }

  remove(root: string): boolean {
    this.changed();
    if (!this.list.includes(root)) return false;
    this.save(this.list.filter((entry) => entry !== root));
    return true;
  }

  private save(list: string[]): void {
    try {
      setShared(KEY, { projects: list });
    } catch (error) {
      throw new Error(`Could not save registered projects: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.list = list;
    this.seen = JSON.stringify(list);
  }
}
