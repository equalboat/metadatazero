import { useEffect, useId, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { baseName, formatSize } from './metadata';
import {
  cropToFill, drawExport, renderExport, imageMime, MAX_EDGE, MAX_PIXELS,
  type ExportFormat,
} from './image-export';

const FORMAT_LABEL = { avif: 'AVIF', webp: 'WebP' };
const WEBFLOW_IMAGE_LIMIT = 4_000_000;

interface Source {
  bitmap: ImageBitmap;
  bytes: number;
  url: string;
}

interface Preview {
  bytes: ArrayBuffer;
  url: string;
  settingsKey: string;
}

export default function ImageExport({ path, name, onClose, showIn }: {
  path: string;
  name: string;
  onClose: () => void;
  showIn: string;
}) {
  const [source, setSource] = useState<Source>();
  const [readError, setReadError] = useState('');
  const [format, setFormat] = useState<ExportFormat>('avif');
  const [options, setOptions] = useState({
    avif: { quality: 50, effort: 4, lossless: false },
    webp: { quality: 75, effort: 4, lossless: false },
  });
  const { quality, effort, lossless } = options[format];
  const [resize, setResize] = useState(false);
  const [mode, setMode] = useState<'fit' | 'crop'>('fit');
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [cropX, setCropX] = useState(50);
  const [cropY, setCropY] = useState(50);
  const [preview, setPreview] = useState<Preview>();
  const [encodeError, setEncodeError] = useState({ key: '', message: '' });
  const [saving, setSaving] = useState(false);
  const [savedTo, setSavedTo] = useState('');
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    let closed = false;
    let loaded: Source | undefined;
    async function load() {
      try {
        const bytes = await invoke<ArrayBuffer | number[]>('read_export_image', { filePath: path });
        if (closed) return;
        const data = Array.isArray(bytes) ? Uint8Array.from(bytes) : bytes;
        const blob = new Blob([data], { type: imageMime(path) });
        const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        if (closed) {
          bitmap.close();
          return;
        }
        loaded = { bitmap, bytes: blob.size, url: URL.createObjectURL(blob) };
        setWidth(String(bitmap.width));
        setHeight(String(bitmap.height));
        setSource(loaded);
      } catch (error) {
        if (!closed) setReadError(error instanceof DOMException ? 'Could not decode this image.' : String(error));
      }
    }
    void load();
    return () => {
      closed = true;
      if (loaded) {
        loaded.bitmap.close();
        URL.revokeObjectURL(loaded.url);
      }
    };
  }, [path]);

  const originalWidth = source?.bitmap.width ?? 0;
  const originalHeight = source?.bitmap.height ?? 0;
  const outputWidth = resize ? Number(width) : originalWidth;
  const outputHeight = resize ? Number(height) : originalHeight;
  const crop = resize && mode === 'crop';
  const valid = [outputWidth, outputHeight].every((value) => Number.isInteger(value) && value > 0 && value <= MAX_EDGE)
    && outputWidth * outputHeight <= MAX_PIXELS;
  const key = JSON.stringify([format, quality, effort, lossless, outputWidth, outputHeight, crop, cropX, cropY]);

  useEffect(() => {
    if (!source || !valid) return;
    const controller = new AbortController();
    let url: string | undefined;
    const timeout = window.setTimeout(async () => {
      try {
        const target = { width: outputWidth, height: outputHeight };
        const area = crop ? cropToFill(source.bitmap, target, cropX, cropY) : {
          x: 0, y: 0, width: source.bitmap.width, height: source.bitmap.height,
        };
        const bytes = await renderExport(() => ({
          pixels: drawExport(source.bitmap, target, area), format, quality, effort, lossless,
        }), controller.signal);
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(new Blob([bytes], { type: `image/${format}` }));
        setPreview({ bytes, url, settingsKey: key });
        setEncodeError({ key: '', message: '' });
      } catch (error) {
        if (!controller.signal.aborted) {
          setEncodeError({ key, message: error instanceof Error ? error.message : String(error) });
        }
      }
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
      if (url) URL.revokeObjectURL(url);
      setPreview(undefined);
    };
  }, [source, valid, key, crop, cropX, cropY, outputWidth, outputHeight, format, quality, effort, lossless]);

  const changeDimension = (axis: 'width' | 'height', value: string) => {
    const setPrimary = axis === 'width' ? setWidth : setHeight;
    const setOther = axis === 'width' ? setHeight : setWidth;
    const ratio = axis === 'width' ? originalHeight / originalWidth : originalWidth / originalHeight;
    setPrimary(value);
    if (mode === 'fit') setOther(Number(value) > 0 ? String(Math.max(1, Math.round(Number(value) * ratio))) : '');
  };

  const changeOptions = (change: Partial<typeof options.avif>) => {
    setOptions((current) => ({ ...current, [format]: { ...current[format], ...change } }));
  };

  const setResizeMode = (value: 'fit' | 'crop') => {
    setMode(value);
    if (value === 'fit') {
      setHeight(Number(width) > 0 ? String(Math.max(1, Math.round(Number(width) * originalHeight / originalWidth))) : '');
    }
  };

  const current = valid && preview?.settingsKey === key ? preview : undefined;
  const size = current?.bytes.byteLength;
  const percent = size !== undefined && source?.bytes ? Math.round(100 * Math.abs(1 - size / source.bytes)) : undefined;
  const error = valid && encodeError.key === key ? encodeError.message : '';
  const savingLabel = `Save clean ${FORMAT_LABEL[format]}`;

  const save = async () => {
    if (!current || saving) return;
    setSaving(true);
    setSavedTo('');
    setSaveError('');
    try {
      const sourcePath = new TextEncoder().encode(path);
      const payload = new Uint8Array(sourcePath.length + 1 + current.bytes.byteLength);
      payload.set(sourcePath);
      payload.set(new Uint8Array(current.bytes), sourcePath.length + 1);
      setSavedTo(await invoke<string>('save_export_image', payload));
    } catch (error) {
      setSaveError(String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="detail-inner export-panel">
      <div className="detail-head">
        <div className="detail-title">
          <h2>Remove metadata &amp; optimize</h2>
          <p className="note">{name}{source && ` · ${originalWidth} × ${originalHeight} px`}</p>
        </div>
        <button className="btn" onClick={onClose}>Back to metadata</button>
      </div>

      {readError && <p className="detail-message error" role="alert">{readError}</p>}
      {!readError && !source && <p className="detail-message" role="status">Reading image…</p>}

      {source && (
        <>
          <div className="export-comparison">
            <figure>
              <figcaption>Original <span>{formatSize(source.bytes)}</span></figcaption>
              <div className="export-image"><img src={source.url} alt="Original image" /></div>
            </figure>
            <figure>
              <figcaption>Export {valid && <span>{outputWidth} × {outputHeight} px</span>}</figcaption>
              <div className="export-image">
                {current
                  ? <img src={current.url} alt={crop ? 'Cropped export preview' : 'Export preview'} />
                  : <p className="note">{!valid || error ? 'Preview unavailable' : 'Encoding preview…'}</p>}
              </div>
            </figure>
          </div>

          <div className="export-controls">
            <fieldset>
              <legend>Dimensions</legend>
              <label className="export-check">
                <input type="checkbox" role="switch" checked={resize} onChange={(event) => setResize(event.target.checked)} />
                Resize
              </label>
              {resize && (
                <>
                  <label className="export-row">Resize method
                    <select value={mode} onChange={(event) => setResizeMode(event.target.value as 'fit' | 'crop')}>
                      <option value="fit">Keep aspect ratio</option>
                      <option value="crop">Crop to fill</option>
                    </select>
                  </label>
                  <div className="export-dimensions">
                    <label>Width (px)
                      <input type="number" min="1" max={MAX_EDGE} step="1" value={width} onChange={(event) => changeDimension('width', event.target.value)} />
                    </label>
                    <label>Height (px)
                      <input type="number" min="1" max={MAX_EDGE} step="1" value={height} onChange={(event) => changeDimension('height', event.target.value)} />
                    </label>
                  </div>
                  {crop && (
                    <>
                      <Slider label="Horizontal crop position" value={cropX} max={100} onChange={setCropX} />
                      <Slider label="Vertical crop position" value={cropY} max={100} onChange={setCropY} />
                    </>
                  )}
                </>
              )}
            </fieldset>

            <fieldset>
              <legend>Compression</legend>
              <label className="export-row">Format
                <select value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}>
                  <option value="avif">AVIF · photos</option>
                  <option value="webp">WebP · graphics</option>
                </select>
              </label>
              <label className="export-check">
                <input type="checkbox" checked={lossless} onChange={(event) => changeOptions({ lossless: event.target.checked })} />
                Lossless encoding
              </label>
              <Slider label="Quality" value={quality} max={100} disabled={lossless} onChange={(value) => changeOptions({ quality: value })} />
              <Slider label="Effort" value={effort} max={format === 'avif' ? 9 : 6} min={format === 'avif' ? 1 : 0} onChange={(value) => changeOptions({ effort: value })} />
            </fieldset>
          </div>

          <div className="export-footer">
            <div aria-live="polite" className="export-size">
              {!valid ? <span className="error">Enter dimensions up to 8,192 px per side and 32 megapixels total.</span>
                : error ? <span className="error">{error}</span>
                : size === undefined ? <span className="note">Calculating output size…</span>
                : <>
                  <strong title={`${size.toLocaleString()} bytes`}>{formatSize(size)}</strong>
                  <span className="note"> · {percent
                    ? `${percent}% ${size < source.bytes ? 'smaller' : 'larger'}`
                    : size === source.bytes ? 'same size' : 'less than 1% change'}</span>
                  {size > WEBFLOW_IMAGE_LIMIT && <p className="error">Above Webflow’s 4 MB image limit.</p>}
                </>}
            </div>
            <div className="export-save">
              <button className="btn-primary" disabled={!current || saving} onClick={save} aria-describedby="export-save-note">
                {saving ? 'Saving…' : savingLabel}
              </button>
              <p className="note" id="export-save-note">Saves a copy without the source metadata.</p>
            </div>
          </div>
          {saveError && <p className="error" role="alert">{saveError}</p>}
          {savedTo && (
            <div className="export-saved" role="status">
              <span>Saved {baseName(savedTo)} without source metadata.</span>
              <button className="btn" onClick={() => void revealItemInDir(savedTo).catch((error) => setSaveError(String(error)))}>{showIn}</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Slider({ label, value, min = 0, max, disabled, onChange }: {
  label: string;
  value: number;
  min?: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <label className="export-slider" htmlFor={id}>
      <span>{label} <span aria-hidden="true">{value}</span></span>
      <input id={id} type="range" min={min} max={max} value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}
