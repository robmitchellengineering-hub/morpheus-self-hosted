// Plain unit conversion — every unit's factor converts to/from its
// category's base unit (metres for length, grams for weight).

export const LENGTH_UNITS = [
  { id: 'mm', label: 'Millimetres (mm)', toBase: 0.001 },
  { id: 'cm', label: 'Centimetres (cm)', toBase: 0.01 },
  { id: 'm', label: 'Metres (m)', toBase: 1 },
  { id: 'km', label: 'Kilometres (km)', toBase: 1000 },
  { id: 'in', label: 'Inches (in)', toBase: 0.0254 },
  { id: 'ft', label: 'Feet (ft)', toBase: 0.3048 },
  { id: 'yd', label: 'Yards (yd)', toBase: 0.9144 },
  { id: 'mi', label: 'Miles (mi)', toBase: 1609.344 },
];

export const WEIGHT_UNITS = [
  { id: 'mg', label: 'Milligrams (mg)', toBase: 0.001 },
  { id: 'g', label: 'Grams (g)', toBase: 1 },
  { id: 'kg', label: 'Kilograms (kg)', toBase: 1000 },
  { id: 'oz', label: 'Ounces (oz)', toBase: 28.349523125 },
  { id: 'lb', label: 'Pounds (lb)', toBase: 453.59237 },
];

export function convert(value, fromId, toId, units) {
  const from = units.find((u) => u.id === fromId);
  const to = units.find((u) => u.id === toId);
  if (!from || !to) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return (n * from.toBase) / to.toBase;
}
