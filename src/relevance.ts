export function affectsPaths(changed: string[], scope: string[]) {
  return changed.length > 0 && (!scope.length || changed.some((file) =>
    scope.some((path) => path === "." || file === path || file.startsWith(path + "/")),
  ));
}
