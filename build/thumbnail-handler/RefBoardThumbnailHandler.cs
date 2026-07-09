using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using SharpShell.Attributes;
using SharpShell.SharpThumbnailHandler;

namespace RefBoard
{
    [ComVisible(true)]
    [DisplayName("RefBoard Thumbnail Handler")]
    [Guid("B8E4F1A2-3C5D-4E6F-9A0B-1C2D3E4F5A6B")]
    [COMServerAssociation(AssociationType.ClassOfExtension, ".refboard")]
    public class RefBoardThumbnailHandler : SharpThumbnailHandler
    {
        private const int MaxReadBytes = 512 * 1024;

        private static readonly Regex PreviewRegex = new Regex(
            "\"preview\"\\s*:\\s*\"([A-Za-z0-9+/=]+)\"",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

        protected override Bitmap GetThumbnailImage(uint width)
        {
            var target = Math.Max(16, Math.Min(1024, (int)width));
            try
            {
                using (var stream = SelectedItemStream)
                {
                    if (stream == null || !stream.CanRead)
                        return FallbackBrand(target);

                    var previewB64 = ExtractPreviewBase64(stream);
                    if (previewB64 == null)
                        return FallbackBrand(target);

                    var bytes = Convert.FromBase64String(previewB64);
                    using (var ms = new MemoryStream(bytes))
                    using (var src = new Bitmap(ms))
                    {
                        return ComposeBranded(src, target);
                    }
                }
            }
            catch
            {
                return FallbackBrand(target);
            }
        }

        private static string ExtractPreviewBase64(Stream stream)
        {
            var headText = ReadChunk(stream, 0);
            if (headText != null)
            {
                var match = PreviewRegex.Match(headText);
                if (match.Success)
                    return match.Groups[1].Value;
            }

            if (stream.CanSeek && stream.Length > MaxReadBytes)
            {
                var tailStart = Math.Max(0, stream.Length - MaxReadBytes);
                var tailText = ReadChunk(stream, tailStart);
                if (tailText != null)
                {
                    var match = PreviewRegex.Match(tailText);
                    if (match.Success)
                        return match.Groups[1].Value;
                }
            }

            return null;
        }

        private static string ReadChunk(Stream stream, long offset)
        {
            if (!stream.CanSeek)
            {
                if (offset != 0) return null;
            }
            else
            {
                stream.Seek(offset, SeekOrigin.Begin);
            }

            var buffer = new byte[MaxReadBytes];
            var totalRead = 0;
            while (totalRead < MaxReadBytes)
            {
                var read = stream.Read(buffer, totalRead, MaxReadBytes - totalRead);
                if (read <= 0) break;
                totalRead += read;
            }

            if (totalRead <= 0) return null;
            return Encoding.UTF8.GetString(buffer, 0, totalRead);
        }

        private static Bitmap ComposeBranded(Bitmap source, int size)
        {
            var canvas = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(canvas))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.SmoothingMode = SmoothingMode.HighQuality;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;

                DrawGradientBackground(g, size);

                var stripW = Math.Max(1, (int)Math.Round(size * 0.80));
                var stripH = Math.Max(1, (int)Math.Round(size * 0.38));
                var stripX = (size - stripW) / 2;
                var stripY = (size - stripH) / 2;
                var radius = Math.Max(4, size / 42);

                using (var shadowPath = RoundedRect(stripX + 1, stripY + 2, stripW, stripH, radius))
                using (var shadowBrush = new SolidBrush(Color.FromArgb(70, 0, 0, 0)))
                    g.FillPath(shadowBrush, shadowPath);

                var scale = Math.Max((float)stripW / source.Width, (float)stripH / source.Height);
                var drawW = source.Width * scale;
                var drawH = source.Height * scale;
                var drawX = stripX + (stripW - drawW) / 2f;
                var drawY = stripY + (stripH - drawH) / 2f;

                using (var clipPath = RoundedRect(stripX, stripY, stripW, stripH, radius))
                {
                    g.SetClip(clipPath);
                    g.DrawImage(source, drawX, drawY, drawW, drawH);
                    DrawStripVignette(g, stripX, stripY, stripW, stripH);
                    g.ResetClip();
                }

                using (var borderPath = RoundedRect(stripX, stripY, stripW, stripH, radius))
                using (var borderPen = new Pen(Color.FromArgb(15, 255, 255, 255), Math.Max(1f, size / 256f)))
                    g.DrawPath(borderPen, borderPath);

                DrawBrandBadge(g, size);
            }
            return canvas;
        }

        private static void DrawGradientBackground(Graphics g, int size)
        {
            using (var bg = new LinearGradientBrush(
                new Rectangle(0, 0, size, size),
                Color.FromArgb(255, 14, 15, 20),
                Color.FromArgb(255, 24, 26, 34),
                LinearGradientMode.Vertical))
            {
                g.FillRectangle(bg, 0, 0, size, size);
            }
        }

        private static void DrawStripVignette(Graphics g, int x, int y, int w, int h)
        {
            using (var vignette = new LinearGradientBrush(
                new Rectangle(x, y, w, h),
                Color.FromArgb(60, 0, 0, 0),
                Color.Transparent,
                LinearGradientMode.Horizontal))
            {
                var blend = new ColorBlend(3);
                blend.Colors = new[] { Color.FromArgb(60, 0, 0, 0), Color.Transparent, Color.FromArgb(60, 0, 0, 0) };
                blend.Positions = new[] { 0f, 0.5f, 1f };
                vignette.InterpolationColors = blend;
                g.FillRectangle(vignette, x, y, w, h);
            }
        }

        private static void DrawBrandBadge(Graphics g, int size)
        {
            var badgeSize = Math.Max(12, (int)Math.Round(size * 0.18));
            var margin = Math.Max(3, size / 24);
            var bx = size - badgeSize - margin;
            var by = size - badgeSize - margin;

            using (var shadowBrush = new SolidBrush(Color.FromArgb(80, 0, 0, 0)))
                g.FillEllipse(shadowBrush, bx + 1, by + 1, badgeSize, badgeSize);

            using (var plateBrush = new SolidBrush(Color.FromArgb(220, 18, 20, 28)))
                g.FillEllipse(plateBrush, bx, by, badgeSize, badgeSize);

            using (var platePen = new Pen(Color.FromArgb(120, 90, 200, 255), Math.Max(1f, size / 128f)))
                g.DrawEllipse(platePen, bx, by, badgeSize, badgeSize);

            using (var brand = LoadBrandImage())
            {
                if (brand == null) return;
                var inset = Math.Max(2, badgeSize / 6);
                g.DrawImage(brand, bx + inset, by + inset, badgeSize - inset * 2, badgeSize - inset * 2);
            }
        }

        private static Bitmap FallbackBrand(int size)
        {
            var canvas = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(canvas))
            {
                g.SmoothingMode = SmoothingMode.HighQuality;
                g.TextRenderingHint = TextRenderingHint.AntiAlias;

                DrawGradientBackground(g, size);

                using (var brand = LoadBrandImage())
                {
                    if (brand != null)
                    {
                        var badge = (int)Math.Round(size * 0.28);
                        var x = (size - badge) / 2;
                        var y = (size - badge) / 2 - size / 16;
                        g.DrawImage(brand, x, y, badge, badge);
                    }
                }

                using (var font = new Font("Segoe UI", Math.Max(6f, size / 22f), FontStyle.Regular, GraphicsUnit.Pixel))
                using (var brush = new SolidBrush(Color.FromArgb(80, 180, 190, 210)))
                {
                    var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Near };
                    g.DrawString("RefBoard", font, brush, size / 2f, size * 0.72f, sf);
                }
            }
            return canvas;
        }

        private static Bitmap LoadBrandImage()
        {
            var asm = Assembly.GetExecutingAssembly();
            using (var stream = asm.GetManifestResourceStream("RefBoard.brand.png"))
            {
                if (stream == null) return null;
                return new Bitmap(stream);
            }
        }

        private static GraphicsPath RoundedRect(int x, int y, int w, int h, int r)
        {
            var path = new GraphicsPath();
            var d = r * 2;
            path.AddArc(x, y, d, d, 180, 90);
            path.AddArc(x + w - d, y, d, d, 270, 90);
            path.AddArc(x + w - d, y + h - d, d, d, 0, 90);
            path.AddArc(x, y + h - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }
}
