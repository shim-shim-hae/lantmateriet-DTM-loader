# Bounding box DTM downloader for the Swedish DTM
This app downloads the Swedish DTM within a specified geometry. The app takes a GeoJSON polygon as input and returns DTM tiles for that area.

## Swedish Lantmäteriet API for DTM data
The app uses the Swedish Lantmäteriet API to download the DTM data.

The API is a STAC API available at the following URL:  
https://api.lantmateriet.se/stac-hojd/v1/

The search endpoint is at:  
https://api.lantmateriet.se/stac-hojd/v1/search

API documentation can be found at the following URL:  
https://api.lantmateriet.se/stac-hojd/v1/api.html

## Environment
The app is built using Node.js and uses the 'axios' library to make HTTP requests to the API. The app also uses the 'fs' library to save the downloaded DTM tiles to the user's computer. For authentication, the app uses the 'dotenv' library to load environment variables. For GeoJSON processing, the app uses the 'Turf.js' library. The app can be run in a terminal or command prompt.

## Input
Input to the app is a polygon in GeoJSON format defined by the coordinates of its vertices. WGS84 coordinate system is used (EPSG:4326).

## Polygon handling
The app uses the 'Turf.js' library to break up the GeoJSON polygon into 10x10 km non-overlapping bounding boxes. The bounding boxes are used to query the API for DTM tiles that intersect with the bounding box.

## API response
The API response is a JSON listing 'collections' of DTM tiles that contain the respective bounding box and 'assets', i.e. the actual DTM tiles within the bounding box.
The download URL is under feature.assets.data.href in the API response and has the following format:  
https://dl1.lantmateriet.se/hojd/data/grid1m/xxx.tif  
where 'xxx' is the tile name, e.g. '65875_6750_25.tif'.

## Output
The app saves a list of download URLs for the DTM tiles that intersect with each input bounding box. Any duplicate URLs are removed. The list is in JSON format, specifying bounding box and download URLs, for example:

{  
    "bounding box_xxx":  
    [  
    "https://dl1.lantmateriet.se/hojd/data/grid1m/65_6/55/65875_6750_25.tif",  
    "https://dl1.lantmateriet.se/hojd/data/grid1m/65_6/55/65875_6750_26.tif"
    ]  
}  

Then the app calculates the total size of the DTM tiles to be downloaded (in GB, tile size times number of tiles) and asks the user if they want to download the tiles. If the user confirms, the app will download the DTM tiles and save them to a specified directory on the user's computer. Download progress is displayed on a bounding box level as a progress bar. Index number of the currently downloading BB and total number of BBs is shown, e.g., "Downloading BB 2 of 5...".
The app will also handle any errors that may occur during the download process, such as network issues or invalid URLs, and will provide appropriate feedback to the user.
The app will also save a manifest file listing the file paths of the downloaded DTM tiles in JSON format, for example:

{  
  "bb_xxx_downloaded_tiles":  
  [  
    "/path/to/downloaded/65875_6750_25.tif",  
    "/path/to/downloaded/65875_6750_26.tif"  
  ]  
}