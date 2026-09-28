# Tribar Corrosion Measurement Tool

Python tool (tb.py, measure3.py, tribar_measure.py) for measuring tribar corrosion directly from photographs, instead of eyeballing percentage loss in the field.

- Core idea: use the tribar's centerline pitch (the spacing between bars) as an internal scale reference, since pitch is fixed by casting and doesn't change as the steel corrodes. The tool detects bar edges and computes a width to pitch ratio per window, then reports width loss against a calibrated baseline.
- Corrosion happens primarily on the width faces of the bar, since that's the surface pigs stand on, so width loss maps roughly 1:1 to cross section loss.
- Baseline: calibrated from new tribar photos taken at C44, came out to a 0.4686 width to pitch ratio across 60 windows, with a 4.3% coefficient of variation.
- Example readings: C70 measured 16.9% width loss. C72 measured approximately 22.6% from two reliable photos, reported as 30 to 40% in the actual letter.
- Best results: perpendicular indoor shots, diffuse light, dark pit behind the bars. Direct sun and flash on wet bars cause specular highlight failures and unreliable readings.
- Takes any number of image paths as arguments, saved to outputs as the three files listed above.

## Stuff to do

- Create app for this like the inspections ones
