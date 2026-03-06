import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execFile);

export async function getBranches(
  repoPath: string,
): Promise<{ name: string; isCurrent: boolean; isRemote: boolean; lastCommitDate: number }[]> {
  try {
    // Get current branch name
    const { stdout: headOut } = await execAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoPath,
    });
    const currentBranch = headOut.trim();

    // Use for-each-ref to get branches with commit dates
    const { stdout } = await execAsync(
      "git",
      [
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname)|%(committerdate:unix)",
        "refs/heads/",
        "refs/remotes/",
      ],
      { cwd: repoPath },
    );

    const seen = new Map<
      string,
      { name: string; isCurrent: boolean; isRemote: boolean; lastCommitDate: number }
    >();

    for (const line of stdout.split("\n")) {
      if (!line.trim()) {
        continue;
      }

      const [refname, dateStr] = line.split("|");
      const lastCommitDate = parseInt(dateStr, 10) * 1000; // convert to ms
      const isRemote = refname.startsWith("refs/remotes/");

      let name: string;
      if (isRemote) {
        // refs/remotes/origin/branch-name -> branch-name
        name = refname.replace(/^refs\/remotes\/[^/]+\//, "");
      } else {
        // refs/heads/branch-name -> branch-name
        name = refname.replace(/^refs\/heads\//, "");
      }

      // Skip HEAD pointer
      if (name === "HEAD") {
        continue;
      }

      const isCurrent = name === currentBranch;

      // Prefer local entries over remote (local comes with isCurrent info)
      if (!seen.has(name)) {
        seen.set(name, { name, isCurrent, isRemote, lastCommitDate });
      } else if (!isRemote) {
        // Local overrides remote
        seen.set(name, { name, isCurrent, isRemote: false, lastCommitDate });
      }
    }

    // Sort: current branch first, then by most recent commit date
    return Array.from(seen.values()).sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) {
        return a.isCurrent ? -1 : 1;
      }
      return b.lastCommitDate - a.lastCommitDate;
    });
  } catch (e) {
    console.error("Failed to get branches", e);
    return [];
  }
}

export async function getWorkingTreeStatus(repoPath: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync("git", ["status", "--porcelain"], { cwd: repoPath });
    return stdout.trim().length > 0;
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
    const { stdout } = await execAsync(
      "git",
      ["log", target, "-n", "100", "--format=%H|%s|%an|%cI"],
      {
        cwd: repoPath,
      },
    );
    const commits = stdout
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
