# Sourced by deploy.sh and test-env-tag.sh: remembers the deployed image tag in the .env.
#
# write_image_tag <env-file> <tag>
# Every step is explicit (`||`), because `set -e` does not apply inside a function that is called as the left side of
# `||`. The new text is made in <env-file>.new first; the .env is touched only after that worked and is checked, and
# then it is overwritten in place, so it keeps its inode, owner and mode. A failure returns 1 with the .env as it was
# (a failed overwrite is put back from a private copy) and no leftover files.
write_image_tag() {
  local file="$1" tag="$2" new="$1.new" old="$1.old"
  if ! grep -q '^IMAGE_TAG=' "$file"; then
    echo "IMAGE_TAG=${tag}" >> "$file" || return 1
    return 0
  fi
  (umask 077 && sed "s|^IMAGE_TAG=.*|IMAGE_TAG=${tag}|" "$file" > "$new") || { rm -f "$new"; return 1; }
  [ -s "$new" ] && grep -qx "IMAGE_TAG=${tag}" "$new" || { rm -f "$new"; return 1; }
  (umask 077 && cp "$file" "$old") || { rm -f "$new" "$old"; return 1; }
  if cat "$new" > "$file"; then
    rm -f "$new" "$old"
    return 0
  fi
  cat "$old" > "$file" || echo "deploy: could not restore $file, a copy is in $old" >&2
  rm -f "$new"
  return 1
}
