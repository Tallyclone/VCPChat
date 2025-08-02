use pyo3::prelude::*;
use numpy::{PyReadonlyArrayDyn, PyArray, Ix1};
use ndarray::Array1;
use rubato::{Resampler, SincFixedIn, SincInterpolationType, SincInterpolationParameters, WindowFunction};

/// This function resamples audio data from a source sample rate to a target sample rate.
/// It's designed to be called from Python and uses high-quality sinc interpolation.
#[pyfunction]
fn resample(
    py: Python,
    input_data: PyReadonlyArrayDyn<f64>,
    original_sr: u32,
    target_sr: u32,
    channels: u32,
) -> PyResult<Py<PyArray<f64, Ix1>>> {
    let input_slice = input_data.as_slice()?;
    
    // Deinterleave the input data
    let mut waves_in: Vec<Vec<f64>> = vec![vec![]; channels as usize];
    for frame in input_slice.chunks_exact(channels as usize) {
        for (chan, sample) in frame.iter().enumerate() {
            waves_in[chan].push(*sample);
        }
    }

    // Configure the Resampler
    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };

    let mut resampler = SincFixedIn::<f64>::new(
        target_sr as f64 / original_sr as f64,
        2.0,
        params,
        waves_in.get(0).map_or(0, |v| v.len()),
        channels as usize,
    ).map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(e.to_string()))?;

    // Process the audio
    let waves_out = resampler.process(&waves_in, None)
        .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(e.to_string()))?;

    // Interleave the output data back into a single Vec
    let num_out_frames = waves_out.get(0).map_or(0, |v| v.len());
    let mut output_vec = vec![0.0f64; num_out_frames * channels as usize];
    for i in 0..num_out_frames {
        for (chan, channel_data) in waves_out.iter().enumerate() {
            output_vec[i * channels as usize + chan] = channel_data[i];
        }
    }
    
    Ok(PyArray::from_vec(py, output_vec).to_owned())
}

/// A Python module implemented in Rust.
#[pymodule]
fn rust_audio_resampler(_py: Python, m: &PyModule) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(resample, m)?)?;
    Ok(())
}