import { customType } from "drizzle-orm/pg-core";

/** PostGIS `geography(Point, 4326)`; read/written as `{ lat, lon }`. */
export const geographyPoint = customType<{ data: { lat: number; lon: number }; driverData: string }>({
	dataType() {
		return "geography(Point, 4326)";
	},
	toDriver(value) {
		return `SRID=4326;POINT(${value.lon} ${value.lat})`;
	},
	fromDriver(value) {
		// Selected via ST_AsText → "POINT(lon lat)"; raw WKB hex is not parsed here,
		// queries that need coordinates select ST_Y/ST_X explicitly.
		const match = /POINT\(([-\d.e]+) ([-\d.e]+)\)/i.exec(value);
		if (!match) return { lat: Number.NaN, lon: Number.NaN };
		return { lon: Number(match[1]), lat: Number(match[2]) };
	},
});

export const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
	dataType() {
		return "bytea";
	},
});
