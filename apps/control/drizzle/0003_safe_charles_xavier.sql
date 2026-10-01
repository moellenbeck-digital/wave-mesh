-- Waves used to share one address range, which only worked because a node
-- belonged to exactly one of them. Now that a device can be in several at once,
-- every wave gets a /16 of its own out of 100.64.0.0/10.
--
-- Blocks go out oldest wave first, so the first one lands on 100.64.0.0/16.
-- Every node keeps its position inside its wave -- 10.77.0.3 becomes 100.64.0.3
-- -- which also leaves the IPv6 addresses untouched, since those are derived
-- from the same host number.

-- A wave that used the whole /10 could hold nodes past the 65 534th, and those
-- have nowhere to go in a /16. Stop rather than write a wrong address.
DO $$
DECLARE offender text;
BEGIN
  SELECT n.ipv4 INTO offender
  FROM nodes n
  JOIN waves w ON w.id = n.wave_id
  WHERE (n.ipv4::inet - split_part(w.ipv4_prefix, '/', 1)::inet) >= 65536
  LIMIT 1;

  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'node % sits beyond the 65534th address of its wave and does not fit a /16', offender;
  END IF;
END $$;--> statement-breakpoint

-- Nodes first: this still reads the old prefix off the wave.
UPDATE nodes SET ipv4 = host(
  (split_part(assigned.new_prefix, '/', 1)::inet)
  + (nodes.ipv4::inet - split_part(assigned.old_prefix, '/', 1)::inet)
)
FROM (
  SELECT id,
         ipv4_prefix AS old_prefix,
         host('100.64.0.0'::inet + ((row_number() OVER (ORDER BY created_at, id) - 1) * 65536)) || '/16'
           AS new_prefix
  FROM waves
) AS assigned
WHERE nodes.wave_id = assigned.id;--> statement-breakpoint

-- Then the waves themselves. The bumped version is what makes every connected
-- node fetch the new map and reconfigure its addresses and routes.
UPDATE waves SET ipv4_prefix = assigned.new_prefix, netmap_version = waves.netmap_version + 1
FROM (
  SELECT id,
         host('100.64.0.0'::inet + ((row_number() OVER (ORDER BY created_at, id) - 1) * 65536)) || '/16'
           AS new_prefix
  FROM waves
) AS assigned
WHERE waves.id = assigned.id;--> statement-breakpoint

CREATE UNIQUE INDEX "waves_ipv4_prefix_idx" ON "waves" USING btree ("ipv4_prefix");
