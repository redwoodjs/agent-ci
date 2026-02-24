export async function getBranches(
  repoPath: string,
): Promise<{ name: string; isCurrent: boolean }[]> {
  try {
    const proc = Bun.spawn(["git", "branch", "--list"], { cwd: repoPath });
    const output = await new Response(proc.stdout).text();
    const branches = output
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const isCurrent = line.startsWith("*");
        const name = line.replace("*", "").trim();
        return { name, isCurrent };
      });
    return branches;
  } catch (e) {
    console.error("Failed to get branches", e);
    return [];
  }
}

export async function getWorkingTreeStatus(repoPath: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", "status", "--porcelain"], { cwd: repoPath });
    const output = await new Response(proc.stdout).text();
    return output.trim().length > 0;
  } catch (e) {
    console.error("Failed to get working tree status", e);
    return false;
  }
}

export async function getGitCommits(
  repoPath: string,
  branch: string,
): Promise<{ id: string; label: string; date: number; author: string }[]> {
  try {
    const target = branch === "WORKING_TREE" ? "HEAD" : branch;
    const proc = Bun.spawn(["git", "log", target, "-n", "100", "--format=%H|%s|%an|%cI"], {
      cwd: repoPath,
    });
    const output = await new Response(proc.stdout).text();
    const commits = output
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const [id, label, author, dateStr] = line.split("|");
        return {
          id,
          label,
          author,
          date: new Date(dateStr).getTime(),
        };
      });
    return commits;
  } catch (e) {
    console.error(`Failed to get git commits for ${branch}`, e);
    return [];
  }
}
