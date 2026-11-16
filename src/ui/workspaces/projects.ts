const KEY = "git-projects";

function load(): string[] {
  const raw = localStorage.getItem(KEY);
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  const projects = typeof value === "object" && value !== null && "projects" in value ? value.projects : [];
  if (!Array.isArray(projects)) return [];
  return [...new Set(projects.filter((root): root is string => typeof root === "string"))];
}

export class ProjectRegistry {
  private list: string[] = [];
  readonly error: string | null = null;

  constructor() {
    try {
      this.list = load();
    } catch (error) {
      this.error = `Registered projects are invalid: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  roots(): readonly string[] {
    return this.list;
  }

  add(root: string): boolean {
    if (this.list.includes(root)) return false;
    this.save([...this.list, root]);
    return true;
  }

  remove(root: string): boolean {
    if (!this.list.includes(root)) return false;
    this.save(this.list.filter((entry) => entry !== root));
    return true;
  }

  private save(list: string[]): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ projects: list }));
    } catch (error) {
      throw new Error(`Could not save registered projects: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.list = list;
  }
}
