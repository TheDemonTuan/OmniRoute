#!/usr/bin/env bash

prune_repository_images() {
    local repository="$1"
    shift
    local image image_id candidate_repository candidate_digest candidate_ref
    local -A protected_ids=()

    (( $# > 0 )) || {
        log "Skipping image retention for $repository: no protected images supplied."
        return 0
    }

    for image in "$@"; do
        [[ "$image" == "$repository"@sha256:* ]] || {
            log "Skipping image retention for $repository: unexpected protected image $image."
            return 0
        }
        image_id="$(docker image inspect "$image" --format '{{.Id}}' 2>/dev/null)" || {
            log "Skipping image retention for $repository: protected image $image is unavailable."
            return 0
        }
        protected_ids["$image_id"]=1
    done

    while IFS='|' read -r candidate_repository candidate_digest; do
        [[ "$candidate_repository" == "$repository" && "$candidate_digest" == sha256:* ]] || continue
        candidate_ref="$candidate_repository@$candidate_digest"
        image_id="$(docker image inspect "$candidate_ref" --format '{{.Id}}' 2>/dev/null)" || continue
        [[ -n "${protected_ids[$image_id]:-}" ]] && continue
        log "Removing old image $candidate_ref"
        docker image rm "$candidate_ref" >/dev/null 2>&1 || \
            log "Could not remove $candidate_ref; Docker may still be using it."
    done < <(docker image ls "$repository" --digests --no-trunc \
        --format '{{.Repository}}|{{.Digest}}')
}
