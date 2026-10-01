-- Undoes the address half of 0003.
--
-- 0003 moved this deployment's wave off 10.77.0.0/16 and into 100.64.0.0/16 on
-- the argument that CGNAT collides with no LAN. It collides with something
-- worse: other mesh VPNs claim 100.64.0.0/10 wherever they run, and one of
-- them drops packets with a source in that range arriving on any interface but
-- its own. IPv4
-- through the tunnel stopped dead while IPv6 carried on -- the ULAs differ, so
-- no rule matched. Measured on a machine running both.
--
-- So the wave goes back exactly where it was, which also gives every device the
-- address it had before 0003. Only a wave sitting on 100.64.0.0/16 is touched;
-- anything else left in the CGNAT range has to be moved by hand, and no
-- deployment has one.

UPDATE nodes SET ipv4 = host('10.77.0.0'::inet + (nodes.ipv4::inet - '100.64.0.0'::inet))
FROM waves w
WHERE w.id = nodes.wave_id AND w.ipv4_prefix = '100.64.0.0/16';--> statement-breakpoint

UPDATE waves SET ipv4_prefix = '10.77.0.0/16', netmap_version = netmap_version + 1
WHERE ipv4_prefix = '100.64.0.0/16';
