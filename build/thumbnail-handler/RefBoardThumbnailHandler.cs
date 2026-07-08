using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
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

                    string text;
                    using (var reader = new StreamReader(stream, detectEncodingFromByteOrderMarks: true))
                    {
                        text = reader.ReadToEnd();
                    }

                    var match = PreviewRegex.Match(text);
                    if (!match.Success)
                        return FallbackBrand(target);

                    var bytes = Convert.FromBase64String(match.Groups[1].Value);
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

        private static Bitmap ComposeBranded(Bitmap source, int size)
        {
            var canvas = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(canvas))
            {
                g.Clear(Color.FromArgb(20, 20, 24));
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.SmoothingMode = SmoothingMode.HighQuality;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;

                var pad = Math.Max(2, size / 32);
                var inner = size - pad * 2;
                var scale = Math.Min((float)inner / source.Width, (float)inner / source.Height);
                var w = Math.Max(1, (int)Math.Round(source.Width * scale));
                var h = Math.Max(1, (int)Math.Round(source.Height * scale));
                var x = pad + (inner - w) / 2;
                var y = pad + (inner - h) / 2;

                using (var path = RoundedRect(x, y, w, h, Math.Max(4, size / 16)))
                {
                    g.SetClip(path);
                    g.DrawImage(source, x, y, w, h);
                    g.ResetClip();
                }

                DrawBrandBadge(g, size);
            }
            return canvas;
        }

        private static void DrawBrandBadge(Graphics g, int size)
        {
            var badgeSize = Math.Max(12, (int)Math.Round(size * 0.26));
            var margin = Math.Max(2, size / 28);
            var bx = size - badgeSize - margin;
            var by = size - badgeSize - margin;

            using (var shadow = RoundedRect(bx + 1, by + 1, badgeSize, badgeSize, badgeSize / 4))
            using (var shadowBrush = new SolidBrush(Color.FromArgb(90, 0, 0, 0)))
                g.FillPath(shadowBrush, shadow);

            using (var plate = RoundedRect(bx, by, badgeSize, badgeSize, badgeSize / 4))
            using (var plateBrush = new SolidBrush(Color.FromArgb(230, 18, 20, 28)))
            using (var platePen = new Pen(Color.FromArgb(180, 90, 200, 255), Math.Max(1f, size / 64f)))
            {
                g.FillPath(plateBrush, plate);
                g.DrawPath(platePen, plate);
            }

            using (var brand = LoadBrandImage())
            {
                if (brand == null) return;
                var inset = Math.Max(2, badgeSize / 7);
                g.DrawImage(brand, bx + inset, by + inset, badgeSize - inset * 2, badgeSize - inset * 2);
            }
        }

        private static Bitmap FallbackBrand(int size)
        {
            var canvas = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(canvas))
            {
                g.Clear(Color.FromArgb(20, 20, 24));
                using (var brand = LoadBrandImage())
                {
                    if (brand == null) return canvas;
                    var badge = (int)Math.Round(size * 0.62);
                    var x = (size - badge) / 2;
                    var y = (size - badge) / 2;
                    g.DrawImage(brand, x, y, badge, badge);
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
