import { describe, it, expect } from "vitest";
import {
  createMachineArgs,
  startArgs,
  runEphemeralArgs,
  execArgs,
  stopArgs,
  deleteArgs,
  listArgs,
  statusArgs,
  packCreateArgs,
} from "./smolvm.js";

describe("smolvm argv builders", () => {
  describe("createMachineArgs", () => {
    it("appends NAME positionally with -I image", () => {
      const [cmd, args] = createMachineArgs("vm1", { image: "ubuntu:22.04" });
      expect(cmd).toBe("smolvm");
      expect(args[0]).toBe("machine");
      expect(args[1]).toBe("create");
      const iIdx = args.indexOf("-I");
      expect(iIdx).toBeGreaterThan(-1);
      expect(args[iIdx + 1]).toBe("ubuntu:22.04");
      expect(args[args.length - 1]).toBe("vm1");
    });

    it("supports a bare VM (no image) — name still positional last", () => {
      const [, args] = createMachineArgs("vm1");
      expect(args).not.toContain("-I");
      expect(args[args.length - 1]).toBe("vm1");
    });

    it("threads cpus / memMib / storageGib / network", () => {
      const [, args] = createMachineArgs("vm1", {
        image: "img",
        cpus: 8,
        memMib: 4096,
        storageGib: 32,
        network: true,
      });
      expect(args[args.indexOf("--cpus") + 1]).toBe("8");
      expect(args[args.indexOf("--mem") + 1]).toBe("4096");
      expect(args[args.indexOf("--storage") + 1]).toBe("32");
      expect(args).toContain("--net");
    });

    it("appends each volume / env / allow-* before the positional name", () => {
      const [, args] = createMachineArgs("vm1", {
        image: "img",
        volumes: ["/src:/app", "/cache:/cache:ro"],
        env: { FOO: "bar" },
        allowCidr: ["10.0.0.0/8"],
        allowHost: ["github.com"],
      });
      const vIdxs = args.reduce<number[]>((a, v, i) => (v === "-v" ? [...a, i] : a), []);
      expect(vIdxs.map((i) => args[i + 1])).toEqual(["/src:/app", "/cache:/cache:ro"]);
      expect(args[args.indexOf("-e") + 1]).toBe("FOO=bar");
      expect(args[args.indexOf("--allow-cidr") + 1]).toBe("10.0.0.0/8");
      expect(args[args.indexOf("--allow-host") + 1]).toBe("github.com");
      expect(args[args.length - 1]).toBe("vm1");
    });
  });

  describe("startArgs", () => {
    it("uses --name", () => {
      expect(startArgs("vm1")).toEqual(["smolvm", ["machine", "start", "--name", "vm1"]]);
    });
  });

  describe("runEphemeralArgs", () => {
    it("does NOT include --name (run is ephemeral) and uses -- before command", () => {
      const [cmd, args] = runEphemeralArgs("alpine", ["echo", "hi"]);
      expect(cmd).toBe("smolvm");
      expect(args[0]).toBe("machine");
      expect(args[1]).toBe("run");
      expect(args).not.toContain("--name");
      const sepIdx = args.indexOf("--");
      expect(sepIdx).toBeGreaterThan(-1);
      expect(args.slice(sepIdx + 1)).toEqual(["echo", "hi"]);
      expect(args[args.indexOf("-I") + 1]).toBe("alpine");
    });

    it("omits the -- separator when no command is given", () => {
      const [, args] = runEphemeralArgs("alpine");
      expect(args).not.toContain("--");
    });

    it("threads -d / --net / --timeout / mem", () => {
      const [, args] = runEphemeralArgs("alpine", ["sh"], {
        detach: true,
        network: true,
        timeout: "30s",
        memMib: 2048,
      });
      expect(args).toContain("-d");
      expect(args).toContain("--net");
      expect(args[args.indexOf("--timeout") + 1]).toBe("30s");
      expect(args[args.indexOf("--mem") + 1]).toBe("2048");
    });
  });

  describe("execArgs", () => {
    it("builds machine exec --name <name> -- <cmd>", () => {
      const [cmd, args] = execArgs("vm1", ["echo", "hello"]);
      expect(cmd).toBe("smolvm");
      expect(args.slice(0, 4)).toEqual(["machine", "exec", "--name", "vm1"]);
      const sepIdx = args.indexOf("--");
      expect(args.slice(sepIdx + 1)).toEqual(["echo", "hello"]);
    });

    it("adds -i / -t flags when requested", () => {
      const [, args] = execArgs("vm1", ["bash"], { interactive: true, tty: true });
      expect(args).toContain("-i");
      expect(args).toContain("-t");
    });

    it("threads workdir and env vars before --", () => {
      const [, args] = execArgs("vm1", ["pwd"], {
        workdir: "/work",
        env: { FOO: "bar", BAZ: "qux" },
      });
      const sepIdx = args.indexOf("--");
      const wIdx = args.indexOf("-w");
      expect(wIdx).toBeGreaterThan(-1);
      expect(wIdx).toBeLessThan(sepIdx);
      expect(args[wIdx + 1]).toBe("/work");
      const envFlags = args.map((v, i) => (v === "-e" ? args[i + 1] : null)).filter(Boolean);
      expect(envFlags).toEqual(["FOO=bar", "BAZ=qux"]);
    });
  });

  it("stopArgs uses --name", () => {
    expect(stopArgs("vm1")).toEqual(["smolvm", ["machine", "stop", "--name", "vm1"]]);
  });

  it("deleteArgs uses positional NAME with -f to skip the prompt", () => {
    expect(deleteArgs("vm1")).toEqual(["smolvm", ["machine", "delete", "-f", "vm1"]]);
  });

  it("listArgs / statusArgs", () => {
    expect(listArgs()).toEqual(["smolvm", ["machine", "ls", "--json"]]);
    expect(statusArgs("vm1")).toEqual(["smolvm", ["machine", "status", "--name", "vm1"]]);
  });

  describe("createMachineArgs --from", () => {
    it("uses --from when fromPack is given", () => {
      const [, args] = createMachineArgs("vm1", { fromPack: "/cache/runner.smolmachine" });
      expect(args).toContain("--from");
      expect(args[args.indexOf("--from") + 1]).toBe("/cache/runner.smolmachine");
      expect(args).not.toContain("-I");
    });

    it("rejects passing both image and fromPack", () => {
      expect(() =>
        createMachineArgs("vm1", { image: "alpine", fromPack: "/x.smolmachine" }),
      ).toThrow(/either `image` or `fromPack`/);
    });
  });

  it("packCreateArgs builds `pack create -I <image> -o <output>`", () => {
    expect(
      packCreateArgs("ghcr.io/actions/actions-runner:latest", "/cache/runner.smolmachine"),
    ).toEqual([
      "smolvm",
      [
        "pack",
        "create",
        "-I",
        "ghcr.io/actions/actions-runner:latest",
        "-o",
        "/cache/runner.smolmachine",
      ],
    ]);
  });
});
